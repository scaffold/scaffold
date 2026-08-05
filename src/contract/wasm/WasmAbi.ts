// deno-lint-ignore-file camelcase -- table keys are the guest-facing wire names
// The one place the WASM ABI is written down.
//
// Each transport used to re-declare all of this (flatRunExports /
// flatWalkExports / flatBuildExports, x3). None of it is transport-specific --
// it is names, arities, and which calls may block. Adding an entry point is a
// table entry here rather than three method implementations.

import { assert, error } from '../../util/functional.ts';
import { maybeThen } from '../../util/MaybePromise.ts';
import { ContractRejection } from '../ContractRejection.ts';
import { ContractEnv } from '../env/ContractEnv.ts';
import {
  ListSink,
  MapSink,
  SinkRoot,
  Source,
  SourceRoot,
  ValueSink,
  ValueType,
} from '../values.ts';
import { hostFn, HostImports } from './WasmTransport.ts';

/**
 * `scaffold_env.*` -- the contract surface, identical under generation and
 * verification. The env is the only thing bound in here; the transport that
 * wires this table never sees it.
 *
 * No `mode` import: a contract that can observe which mode it is in can
 * produce a non-unique result, so the distinction stays on the host side.
 */
export function runImports(env: ContractEnv, onDebug?: (message: string) => void): HostImports {
  return {
    contract_hash: hostFn([], 'bytes', false, () => env.contractHash().toBytes()),

    params: hostFn([], 'bytes', false, () => env.params()),

    claim: hostFn([], 'bytes', true, () => env.claim()),

    get_result: hostFn([], 'bytes', true, () => env.getResult()),

    set_result: hostFn(['bytes'], 'void', false, (data) => env.setResult(data)),

    // Diagnostic only; never traps, and silently drops when the host binds no sink.
    debug: hostFn(['str'], 'void', false, (message) => onDebug?.(message)),

    // The transport turns the throw into a guest trap, and re-throws it from
    // invoke() even if the guest catches the trap: a guest cannot un-reject
    // itself.
    reject: hostFn(['str'], 'void', false, (reason) => {
      throw new ContractRejection(reason);
    }),
  };
}

// Imports this table will grow as ContractEnv does, roughly the v1 set:
// contract_metadata(bytes)->bytes, claim_all(i32)->bytes, emit_output(bytes),
// fetch(bytes)->bytes, put(bytes, bytes)->bytes (returning the hash, unlike
// v1's void -- a put-dependent result is only re-verifiable with it),
// sign(bytes), timestamp_gte(i64). Each is one hostFn line once its env
// method exists; the codecs they need (predicates, outputs, claims) land with
// them.

// Empty key/descriptor strings mean "none" on the wire.
const desc = (d: string) => d === '' ? undefined : d;

type WalkFrame = { kind: 'list'; sink: ListSink } | { kind: 'map'; sink: MapSink };

/**
 * `scaffold_walker.*` -- the walk_params/walk_data surface. All sync: v2
 * sinks are synchronous. Select-then-emit: each slot is selected exactly once
 * (root / map_at / list_at) and consumed by exactly one set_* / begin_*.
 * When begin_* returns 0 the host declined to descend and the guest must skip
 * the whole subtree: no child selects, no end_*. Any protocol violation
 * crashes the guest; call finish() after the entry returns to catch an
 * unbalanced walk.
 */
export function walkImports(sink: SinkRoot): { imports: HostImports; finish(): void } {
  let root: SinkRoot | undefined = sink;
  let selected: ValueSink | undefined;
  const frames: WalkFrame[] = [];

  const select = (s: ValueSink) => {
    assert(selected === undefined, 'walk: previous selection was never emitted');
    selected = s;
  };
  const take = (): ValueSink => {
    const s = selected ?? error('walk: no sink selected');
    selected = undefined;
    return s;
  };
  const topMap = (): MapSink => {
    const frame = frames.at(-1) ?? error('walk: no open container');
    assert(frame.kind === 'map', 'walk: open container is not a map');
    return frame.sink;
  };
  const topList = (): ListSink => {
    const frame = frames.at(-1) ?? error('walk: no open container');
    assert(frame.kind === 'list', 'walk: open container is not a list');
    return frame.sink;
  };
  const begin = (s: MapSink | ListSink | undefined, kind: WalkFrame['kind']): number => {
    if (s === undefined) return 0;
    frames.push({ kind, sink: s } as WalkFrame);
    return 1;
  };
  const end = (kind: WalkFrame['kind']) => {
    assert(selected === undefined, 'walk: selection left unemitted in closing container');
    const frame = frames.pop() ?? error('walk: no open container');
    assert(frame.kind === kind, `walk: open container is not a ${kind}`);
  };

  const imports: HostImports = {
    root: hostFn(['str'], 'void', false, (descriptor) => {
      const r = root ?? error('walk: root already selected');
      root = undefined;
      select(r(desc(descriptor)));
    }),
    map_at: hostFn(['str', 'str'], 'void', false, (key, descriptor) => {
      select(topMap().at(key, desc(descriptor)));
    }),
    list_at: hostFn(['i32', 'str'], 'void', false, (index, descriptor) => {
      select(topList().at(index, desc(descriptor)));
    }),
    set_unit: hostFn([], 'void', false, () => take().setUnit()),
    set_bool: hostFn(['i32'], 'void', false, (value) => take().setBool(value !== 0)),
    set_number: hostFn(['f64'], 'void', false, (value) => take().setNumber(value)),
    set_string: hostFn(['str'], 'void', false, (value) => take().setString(value)),
    set_bytes: hostFn(['bytes'], 'void', false, (value) => take().setBytes(value)),
    begin_map: hostFn([], 'i32', false, () => begin(take().setMap(), 'map')),
    end_map: hostFn([], 'void', false, () => end('map')),
    // length < 0 encodes "unknown".
    begin_list: hostFn([], 'i32', false, () => begin(take().setList(), 'list')),
    end_list: hostFn([], 'void', false, () => end('list')),
    fail: hostFn(['str'], 'void', false, (message) => error(`walk failed: ${message}`)),
  };

  return {
    imports,
    finish() {
      assert(root === undefined, 'walk: guest never selected the root');
      assert(selected === undefined, 'walk: selection was never emitted');
      assert(frames.length === 0, 'walk: guest left a container open');
    },
  };
}

/**
 * `scaffold_builder.*` -- the build_params/build_data surface. A cursor over
 * the pull-model Source tree: navigation (root / map_at / list_at)
 * resolves a source, selects it, and returns its ValueType tag, or -1 for
 * absent. get_* reads the selected scalar; enter/exit descend into and out of
 * the selected container. Navigation may block (Source.at is MaybePromise);
 * everything else is sync. Type mismatches crash the guest, no coercion.
 */
export function buildImports(source: SourceRoot): HostImports {
  let root: SourceRoot | undefined = source;
  let selected: Source | undefined;
  const frames: (Source & { type: ValueType.List | ValueType.Map })[] = [];

  const expect = <T extends Source['type']>(type: T): Extract<Source, { type: T }> => {
    const s = selected ?? error('build: no source selected');
    assert(s.type === type, `build: selected source is not a ${ValueType[type]}`);
    return s as Extract<Source, { type: T }>;
  };
  const selectResolved = (s: Source | undefined): number => {
    selected = s;
    return s?.type ?? -1;
  };

  return {
    root: hostFn(['str'], 'i32', true, (descriptor) => {
      const r = root ?? error('build: root already requested');
      root = undefined;
      return maybeThen(r(desc(descriptor)), selectResolved);
    }),
    map_at: hostFn(['str', 'str'], 'i32', true, (key, descriptor) => {
      const frame = frames.at(-1) ?? error('build: no open container');
      assert(frame.type === ValueType.Map, 'build: open container is not a Map');
      return maybeThen(frame.at(key, desc(descriptor)), selectResolved);
    }),
    list_at: hostFn(['i32', 'str'], 'i32', true, (index, descriptor) => {
      const frame = frames.at(-1) ?? error('build: no open container');
      assert(frame.type === ValueType.List, 'build: open container is not a List');
      return maybeThen(frame.at(index, desc(descriptor)), selectResolved);
    }),
    enter: hostFn([], 'void', false, () => {
      const s = selected ?? error('build: no source selected');
      assert(
        s.type === ValueType.List || s.type === ValueType.Map,
        'build: selected source is not a container',
      );
      frames.push(s);
    }),
    exit: hostFn([], 'void', false, () => {
      if (frames.pop() === undefined) error('build: no open container');
    }),
    length: hostFn([], 'i32', false, () => expect(ValueType.List).length ?? -1),
    get_bool: hostFn([], 'i32', false, () => expect(ValueType.Bool).value ? 1 : 0),
    get_number: hostFn([], 'f64', false, () => expect(ValueType.Number).value),
    get_string: hostFn([], 'str', false, () => expect(ValueType.String).value),
    get_bytes: hostFn([], 'bytes', false, () => expect(ValueType.Bytes).value),
    fail: hostFn(['str'], 'void', false, (message) => error(`build failed: ${message}`)),
  };
}
