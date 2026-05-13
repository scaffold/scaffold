// Contract-trace snapshot test helper. See docs/design/wasi-shim.md
// (Testing Strategy section) for the design rationale.
//
// Usage:
//
//   import { assertContractTraceSnapshot } from './helpers/contractSnapshot.ts';
//
//   Deno.test('my contract', async (t) => {
//     await assertContractTraceSnapshot(t, {
//       records: { modules: { ... } },
//       blobs: { [echoHash.toHex()]: echoWasmBytes },
//       mock: { params: utf8('hi'), mode: ExecutionMode.Verification },
//       sequence: [
//         { type: 'emit_output', expect: { verifier: {...} } },
//         { type: 'reject', expect: { reason: 'oops' } },
//       ],
//     });
//   });
//
// First run: pass `-- --update` to deno test to generate the snapshot file.
// Subsequent runs: helper diffs against the snapshot; failures show a diff.
//
// Architecture:
//   - `MockSequenceEnv` implements ContractEnv. Each call:
//       1. Records a trace event (semantic args).
//       2. Looks up the method in `mock`; if present, returns mock value.
//       3. Else, pops next `sequence` entry; verifies type + `expect`; returns `respond`.
//       4. On dispatch failure: throws Error (test fails before snapshot).
//   - Helper builds a CompiledModules from `records` + `blobs`, then runs
//     the entry export (mirrors InProcessMockTransport.run), passing a
//     tracer to loadModules to capture cross-layer JS-forwarder hops.
//   - `reject` is a sequence entry like any other: its respond is the trap.
//     Helper catches ContractRejection at the outer boundary, checks the
//     trace's last event was a reject step that consumed the entry, and
//     records the rejection.

import { assertSnapshot } from '@std/testing/snapshot';
import { Hash } from '../../src/util/Hash.ts';
import {
  type Claim,
  type ContractEnv,
  ContractRejection,
  ExecutionMode,
} from '../../src/core/ContractEnv.ts';
import type { Output, Verifier } from '../../src/core/BlockCreationModule.ts';
import { composeGenesisPacket } from '../../src/core/Block.ts';
import { makeRecordOutput } from '../../src/contracts/RecordContract.ts';
import { RECORD_CONTRACT } from '../../src/core/Block.ts';
import { EXIT_ZERO_REASON } from '../../src/contracts/wasi-shim/setup.ts';
import {
  type CompiledLayer,
  type CompiledModules,
  loadModules,
  parseModules,
  type TargetRef,
  type TracerEvent,
} from '../../src/plugins/wasm/WasmModules.ts';
import { makeRunBridge, parseValueDescriptor } from '../../src/plugins/wasm/WasmHostBridge.ts';
import { packPtrLen } from '../../src/plugins/wasm/WasmWireCodec.ts';

// -- Public types -----------------------------------------------------

export interface MockTable {
  /** ExecutionMode value returned from `env.mode`. */
  mode?: ExecutionMode;
  contractHash?: Hash;
  params?: Uint8Array;
  timestamp?: number;
  /** Per-method responses. `null` indicates void-returning calls. */
  emit_output?: null;
  request_body?: { value: number; body: Uint8Array };
  fetch?: Uint8Array;
  claim_next?: Claim;
  claim_all?: Claim[];
  /**
   * Configured response. `null` triggers the strict-throws-on-missing path:
   * the env throws `ContractRejection` and the WasmHostBridge converts that
   * to the empty-bytes sentinel for the WASI shim.
   */
  contract_metadata?: { value: number; body: Uint8Array } | null;
  sign?: null;
  put?: null;
  record?: null;
  debug?: null;
  reject?: null;
}

export type SequenceStep =
  | {
    type: 'emit_output';
    expect?: { verifier?: Partial<Verifier>; value?: number; body?: Uint8Array };
  }
  | {
    type: 'request_body';
    expect?: { verifier?: Partial<Verifier> };
    respond: { value: number; body: Uint8Array };
  }
  | {
    type: 'fetch';
    expect?: { verifier?: Partial<Verifier>; key?: Uint8Array };
    respond: Uint8Array;
  }
  | { type: 'claim_next'; expect?: Record<string, never>; respond: Claim }
  | { type: 'claim_all'; expect?: { limit?: number }; respond: Claim[] }
  | {
    type: 'contract_metadata';
    expect?: { verifier?: Partial<Verifier> };
    respond: { value: number; body: Uint8Array };
  }
  | { type: 'sign'; expect?: { pubkey?: Uint8Array } }
  | { type: 'put'; expect?: { verifier?: Partial<Verifier>; records?: Output[] } }
  | { type: 'record'; expect?: { key?: Uint8Array; value?: Uint8Array } }
  | { type: 'debug'; expect?: { message?: string } }
  | { type: 'reject'; expect?: { reason?: string } };

export interface ContractSnapshotOptions {
  /** Records on the contract block. Object values are JSON-stringified; Uint8Array passes through. */
  records: Record<string, unknown>;
  /** WASM blob bytes keyed by hex hash. Each layer's `wasmHash` must be a key here. */
  blobs?: Record<string, Uint8Array>;
  /** Which scaffold entry mode to invoke. v1 supports `'run'` only. */
  entryMode?: 'run';
  mock: MockTable;
  sequence: readonly SequenceStep[];
}

// -- Trace events -----------------------------------------------------

type TraceEvent =
  | { kind: 'entry'; target: TargetRef; entryMode: string }
  | {
    kind: 'host_call';
    method: string;
    args: unknown;
    result?: unknown;
    source: 'mock' | 'sequence';
    sequenceIndex?: number;
  }
  | { kind: 'forwarder_enter'; srcLayer: string; target: TargetRef; declared: string }
  | {
    kind: 'forwarder_exit';
    srcLayer: string;
    target: TargetRef;
    declared: string;
    threw: boolean;
  }
  | { kind: 'rejected'; reason: string }
  | { kind: 'exit_ok' };

// -- MockSequenceEnv --------------------------------------------------

class SequenceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SequenceMismatchError';
  }
}

/**
 * Sentinel error thrown by `MockSequenceEnv.reject` when the WASI shim's
 * `proc_exit(0)` magic string is observed. Caught by the outer helper and
 * treated as clean termination. Tests for shim-backed contracts therefore
 * don't need a `reject` step in their sequence for `proc_exit(0)`.
 */
class WasiCleanExit extends Error {
  constructor() {
    super('WasiCleanExit');
    this.name = 'WasiCleanExit';
  }
}

class MockSequenceEnv implements ContractEnv {
  private cursor = 0;

  readonly mode: ExecutionMode;

  constructor(
    private readonly _mock: MockTable,
    private readonly _sequence: readonly SequenceStep[],
    private readonly _trace: TraceEvent[],
  ) {
    this.mode = _mock.mode ?? ExecutionMode.Verification;
  }

  get sequenceCursor(): number {
    return this.cursor;
  }

  contractHash(): Hash {
    return this._mock.contractHash ?? Hash.fromBytes(new Uint8Array(32));
  }

  params(): Uint8Array {
    return this._mock.params ?? new Uint8Array(0);
  }

  timestamp(): number {
    return this._mock.timestamp ?? 0;
  }

  emitOutput(verifier: Verifier, value: number, body?: Uint8Array): void {
    this._dispatch('emit_output', { verifier, value, body: body ?? new Uint8Array(0) });
  }

  requestBody(verifier: Verifier): { value: number; body: Uint8Array } {
    return this._dispatch('request_body', { verifier }) as { value: number; body: Uint8Array };
  }

  fetch(verifier: Verifier, key: Uint8Array): Uint8Array {
    return this._dispatch('fetch', { verifier, key }) as Uint8Array;
  }

  claimNext(): Claim {
    return this._dispatch('claim_next', {}) as Claim;
  }

  claimAll(limit?: number): Claim[] {
    return this._dispatch('claim_all', { limit: limit ?? -1 }) as Claim[];
  }

  contractMetadata(verifier: Verifier): { value: number; body: Uint8Array } {
    // Mock convention: `contract_metadata: null` in the mock table means
    // "record absent." Production envs throw `ContractRejection` for this
    // case (the WasmHostBridge converts that to the empty-bytes sentinel
    // for the WASI shim). Mirror that here so the trace records both the
    // dispatch and the throw path.
    if (
      Object.prototype.hasOwnProperty.call(this._mock, 'contract_metadata') &&
      this._mock.contract_metadata === null
    ) {
      this._trace.push({
        kind: 'host_call',
        method: 'contract_metadata',
        args: { verifier },
        result: null,
        source: 'mock',
      });
      throw new ContractRejection('no matching output on contract block');
    }
    return this._dispatch('contract_metadata', { verifier }) as { value: number; body: Uint8Array };
  }

  sign(pubkey: Uint8Array): void {
    this._dispatch('sign', { pubkey });
  }

  debug(message: string): void {
    this._dispatch('debug', { message });
  }

  put(verifier: Verifier, records: Output[]): void {
    this._dispatch('put', { verifier, records });
  }

  record(key: Uint8Array, value: Uint8Array): void {
    this._dispatch('record', { key, value });
  }

  /** Called from the run bridge's `reject` handler. Throws ContractRejection. */
  reject(reason: string): never {
    // Special case: the WASI shim's `proc_exit(0)` rejects with a magic
    // sentinel string. Treat that as clean termination so shim-backed
    // contracts don't need to spell out a `reject` step in their sequence
    // for the (very common) clean-exit case. The trace records `exit_ok`
    // instead of a reject host_call.
    if (reason === EXIT_ZERO_REASON) {
      this._trace.push({ kind: 'exit_ok' });
      throw new WasiCleanExit();
    }
    this._dispatch('reject', { reason });
    // Even if dispatch records the call, we still need to throw to terminate.
    throw new ContractRejection(reason);
  }

  private _dispatch(method: string, args: Record<string, unknown>): unknown {
    // Mock-first: short-circuit if the method has a configured response.
    const mockKey = method as keyof MockTable;
    if (Object.prototype.hasOwnProperty.call(this._mock, mockKey)) {
      const respond = this._mock[mockKey];
      this._trace.push({
        kind: 'host_call',
        method,
        args,
        result: respond,
        source: 'mock',
      });
      // null means "void return"; otherwise return the configured value.
      return respond ?? undefined;
    }

    // Fall through to sequence.
    if (this.cursor >= this._sequence.length) {
      const argsHint = renderArgs(args);
      const argsTail = argsHint ? ` with args (${argsHint})` : '';
      throw new SequenceMismatchError(
        `sequence exhausted: contract called \`${method}\`${argsTail} but no more entries`,
      );
    }
    const step = this._sequence[this.cursor];
    const stepIndex = this.cursor;
    this.cursor += 1;

    if (step.type !== method) {
      const argsHint = renderArgs(args);
      const argsTail = argsHint ? ` with args (${argsHint})` : '';
      throw new SequenceMismatchError(
        `sequence step #${stepIndex + 1}: expected ${JSON.stringify(step.type)} ` +
          `but contract called ${JSON.stringify(method)}${argsTail}`,
      );
    }
    if (step.expect) {
      matchExpect(step.expect, args, stepIndex);
    }

    const result = 'respond' in step ? step.respond : undefined;
    this._trace.push({
      kind: 'host_call',
      method,
      args,
      result,
      source: 'sequence',
      sequenceIndex: stepIndex + 1,
    });
    return result;
  }
}

// -- Partial-match verification --------------------------------------

function matchExpect(expect: unknown, actual: unknown, stepIndex: number): void {
  if (expect === undefined) return;
  if (expect instanceof Uint8Array) {
    if (!(actual instanceof Uint8Array) || !bytesEqual(expect, actual)) {
      throw new SequenceMismatchError(
        `sequence step #${stepIndex + 1}: expected bytes ${renderBytes(expect)} but got ${
          actual instanceof Uint8Array ? renderBytes(actual) : String(actual)
        }`,
      );
    }
    return;
  }
  if (expect instanceof Hash) {
    if (!(actual instanceof Hash) || !Hash.equals(expect, actual)) {
      throw new SequenceMismatchError(
        `sequence step #${stepIndex + 1}: expected Hash ${expect.toHex()} but got ${
          actual instanceof Hash ? actual.toHex() : String(actual)
        }`,
      );
    }
    return;
  }
  if (typeof expect !== 'object' || expect === null) {
    if (expect !== actual) {
      throw new SequenceMismatchError(
        `sequence step #${stepIndex + 1}: expected ${JSON.stringify(expect)} but got ${
          JSON.stringify(actual)
        }`,
      );
    }
    return;
  }
  // Object: recurse only on keys present in expect.
  if (typeof actual !== 'object' || actual === null) {
    throw new SequenceMismatchError(
      `sequence step #${stepIndex + 1}: expected an object but got ${typeof actual}`,
    );
  }
  for (const [k, v] of Object.entries(expect)) {
    matchExpect(v, (actual as Record<string, unknown>)[k], stepIndex);
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// -- Trace rendering --------------------------------------------------

function renderBytes(b: Uint8Array): string {
  // Printable ASCII (32..126) or empty → quoted string. Else hex.
  if (b.length === 0) return 'bytes(0) ""';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c < 32 || c > 126) {
      return `bytes(${b.length}) 0x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return `bytes(${b.length}) ${JSON.stringify(new TextDecoder().decode(b))}`;
}

function renderHash(h: Hash): string {
  const hex = h.toHex();
  if (Hash.equals(h, RECORD_CONTRACT)) return `RECORD_CONTRACT(${hex.slice(0, 8)}..)`;
  return `0x${hex}`;
}

function renderVerifier(v: Verifier): string {
  return `Verifier{contract=${renderHash(v.contract)}, params=${renderBytes(v.params)}}`;
}

function renderArg(value: unknown): string {
  if (value === undefined || value === null) return String(value);
  if (value instanceof Uint8Array) return renderBytes(value);
  if (value instanceof Hash) return renderHash(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(renderArg).join(', ')}]`;
  if (typeof value === 'object') {
    // Verifier?
    const v = value as Record<string, unknown>;
    if (v.contract instanceof Hash && v.params instanceof Uint8Array) {
      return renderVerifier(value as Verifier);
    }
    const parts = Object.entries(v).map(([k, x]) => `${k}=${renderArg(x)}`);
    return `{${parts.join(', ')}}`;
  }
  return String(value);
}

function renderArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  if (typeof args !== 'object') return renderArg(args);
  // host_call args are { verifier, value, ... }
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => `${k}=${renderArg(v)}`)
    .join(', ');
}

function formatTrace(events: readonly TraceEvent[]): string {
  let depth = 0;
  const lines: string[] = [];
  const indent = () => '  '.repeat(depth);
  for (const ev of events) {
    switch (ev.kind) {
      case 'entry':
        lines.push(
          `${indent()}> entry ${ev.target.layerKey}:${ev.target.exportName} (mode=${ev.entryMode})`,
        );
        depth += 1;
        break;
      case 'host_call': {
        const argsStr = renderArgs(ev.args);
        const head = `${indent()}> scaffold_env.${ev.method}(${argsStr})`;
        const tail = ev.source === 'mock'
          ? ' [mock]'
          : ` [sequence #${ev.sequenceIndex}: ${ev.method} ✓]`;
        const ret = ev.result === undefined ? '' : ` -> ${renderArg(ev.result)}`;
        lines.push(`${head}${tail}${ret}`);
        break;
      }
      case 'forwarder_enter':
        lines.push(
          `${indent()}> forward ${ev.srcLayer} -> ${ev.target.layerKey}:${ev.target.exportName} (${ev.declared})`,
        );
        depth += 1;
        break;
      case 'forwarder_exit':
        depth -= 1;
        lines.push(`${indent()}< return${ev.threw ? ' (threw)' : ''}`);
        break;
      case 'rejected':
        depth = Math.max(0, depth - 1);
        lines.push(`${indent()}< rejected ${JSON.stringify(ev.reason)}`);
        break;
      case 'exit_ok':
        depth = Math.max(0, depth - 1);
        lines.push(`${indent()}< exit ok`);
        break;
    }
  }
  return lines.join('\n');
}

// -- Block / CompiledModules construction -----------------------------

function recordsMapToOutputs(records: Record<string, unknown>): Output[] {
  const outputs: Output[] = [];
  for (const [key, value] of Object.entries(records)) {
    let body: Uint8Array;
    if (value instanceof Uint8Array) {
      body = value;
    } else if (typeof value === 'object' && value !== null) {
      body = new TextEncoder().encode(JSON.stringify(value));
    } else if (typeof value === 'string') {
      body = new TextEncoder().encode(value);
    } else {
      throw new Error(
        `contractSnapshot: record ${JSON.stringify(key)} must be Uint8Array, object, or string ` +
          `(got ${typeof value})`,
      );
    }
    outputs.push(makeRecordOutput(key, body));
  }
  return outputs;
}

async function buildCompiledModules(
  records: Record<string, unknown>,
  blobs: Record<string, Uint8Array>,
): Promise<CompiledModules> {
  const block = composeGenesisPacket(recordsMapToOutputs(records));
  // Pull the modules record back out of the block to parse via the same path
  // production uses.
  const modulesValue = records.modules;
  if (modulesValue === undefined) {
    throw new Error('contractSnapshot: records.modules is required');
  }
  const modulesBytes = modulesValue instanceof Uint8Array
    ? modulesValue
    : new TextEncoder().encode(JSON.stringify(modulesValue));
  const normalised = parseModules(modulesBytes);

  const layers: CompiledLayer[] = [];
  const byKey = new Map<string, CompiledLayer>();
  for (const layer of normalised.layers) {
    const hex = layer.blobHash.toHex().toLowerCase();
    const bytes = blobs[hex] ?? blobs[layer.blobHash.toHex()];
    if (!bytes) {
      throw new Error(
        `contractSnapshot: no bytes for layer ${JSON.stringify(layer.key)} (wasmHash=${hex}); ` +
          `add it to the \`blobs\` option`,
      );
    }
    // Copy to owned buffer to satisfy WebAssembly.compile.
    const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    owned.set(bytes);
    const module = await WebAssembly.compile(owned);
    const entry: CompiledLayer = { key: layer.key, module, imports: layer.imports };
    layers.push(entry);
    byKey.set(layer.key, entry);
  }
  void block; // Currently unused -- the helper bypasses ContractHost / plugin lookup.
  return { base: normalised.base, layers, byKey };
}

// -- Scaffold flat exports (mirrors InProcessMockTransport) -----------

interface InstanceCtx {
  memory: WebAssembly.Memory;
  alloc: (size: number) => number;
}

function readSlice(ctx: InstanceCtx, ptr: number, len: number): Uint8Array {
  return new Uint8Array(ctx.memory.buffer, ptr, len).slice();
}

function allocAndWrite(ctx: InstanceCtx, bytes: Uint8Array): number {
  const ptr = ctx.alloc(bytes.length);
  new Uint8Array(ctx.memory.buffer, ptr, bytes.length).set(bytes);
  return ptr;
}

function expectSync<T>(value: T | Promise<T>): T {
  if (value instanceof Promise) {
    throw new Error('contractSnapshot: bridge returned a Promise; helper requires sync env');
  }
  return value;
}

function flatRunExports(ctx: InstanceCtx, env: MockSequenceEnv): Record<string, unknown> {
  // Construct a real bridge wrapping the MockSequenceEnv. The bridge is the
  // unchanged production path -- it does the wire-format marshalling. We do
  // not separately wrap it; tracing happens at the env level. `reject` is the
  // one exception: the production bridge throws ContractRejection without
  // consulting the env, which bypasses our sequence machinery. Route
  // `reject` directly through MockSequenceEnv.reject so the sequence entry
  // is consumed before the trap.
  const bridge = makeRunBridge(env);
  const packed = (bytes: Uint8Array): bigint => {
    const ptr = allocAndWrite(ctx, bytes);
    return packPtrLen(ptr, bytes.length);
  };
  return {
    mode: () => bridge.mode(),
    contract_hash: () => packed(bridge.contractHash()),
    contract_metadata: (vp: number, vl: number) =>
      packed(expectSync(bridge.contractMetadata(readSlice(ctx, vp, vl)))),
    params: () => packed(bridge.params()),
    timestamp: () => bridge.timestamp(),
    claim_next: () => packed(expectSync(bridge.claimNext())),
    claim_all: (limit: number) => packed(expectSync(bridge.claimAll(limit))),
    emit_output: (op: number, ol: number) => {
      bridge.emitOutput(readSlice(ctx, op, ol));
    },
    request_body: (vp: number, vl: number) =>
      packed(expectSync(bridge.requestBody(readSlice(ctx, vp, vl)))),
    fetch: (vp: number, vl: number, kp: number, kl: number) =>
      packed(expectSync(bridge.fetch(readSlice(ctx, vp, vl), readSlice(ctx, kp, kl)))),
    put: (vp: number, vl: number, rp: number, rl: number) => {
      expectSync(bridge.put(readSlice(ctx, vp, vl), readSlice(ctx, rp, rl)));
    },
    sign: (pp: number, pl: number) => {
      bridge.sign(readSlice(ctx, pp, pl));
    },
    // /out/debug routing for the WASI shim. Routes through the mock env so
    // each line shows up in the trace as a `host_call` step.
    debug: (rp: number, rl: number) => {
      bridge.debug(readSlice(ctx, rp, rl));
    },
    reject: (rp: number, rl: number) => {
      env.reject(new TextDecoder().decode(readSlice(ctx, rp, rl)));
    },
  };
  void parseValueDescriptor; // walker/builder hooks not wired in v1
}

// -- Main API ---------------------------------------------------------

export async function assertContractTraceSnapshot(
  t: Deno.TestContext,
  options: ContractSnapshotOptions,
): Promise<void> {
  const entryMode = options.entryMode ?? 'run';
  if (entryMode !== 'run') {
    throw new Error(`contractSnapshot: only 'run' mode is supported in v1 (got ${entryMode})`);
  }
  const trace: TraceEvent[] = [];

  const compiled = await buildCompiledModules(options.records, options.blobs ?? {});
  const entryRef = compiled.base.imports.get(entryMode);
  if (!entryRef) {
    throw new Error(
      `contractSnapshot: modules.base.imports has no entry for ${JSON.stringify(entryMode)}`,
    );
  }
  trace.push({ kind: 'entry', target: entryRef, entryMode });

  const env = new MockSequenceEnv(options.mock, options.sequence, trace);
  const ctx: InstanceCtx = {
    memory: null as unknown as WebAssembly.Memory,
    alloc: () => {
      throw new Error('alloc called before instantiation');
    },
  };
  const scaffoldFlat = flatRunExports(ctx, env);

  const tracer = (ev: TracerEvent): void => {
    if (ev.phase === 'enter') {
      trace.push({
        kind: 'forwarder_enter',
        srcLayer: ev.srcLayer,
        target: ev.target,
        declared: ev.declared,
      });
    } else {
      trace.push({
        kind: 'forwarder_exit',
        srcLayer: ev.srcLayer,
        target: ev.target,
        declared: ev.declared,
        threw: ev.error !== undefined,
      });
    }
  };

  const { exportsByKey, entryMemory } = await loadModules(
    compiled,
    scaffoldFlat,
    entryRef,
    tracer,
  );
  ctx.memory = entryMemory;
  const entryExports = exportsByKey.get(entryRef.layerKey);
  if (!entryExports) {
    throw new Error(
      `contractSnapshot: entry layer ${JSON.stringify(entryRef.layerKey)} not found in exports`,
    );
  }
  const alloc = entryExports.alloc;
  if (typeof alloc !== 'function') {
    throw new Error(
      `contractSnapshot: entry layer ${JSON.stringify(entryRef.layerKey)} missing \`alloc\``,
    );
  }
  ctx.alloc = alloc as (size: number) => number;
  const fn = entryExports[entryRef.exportName];
  if (typeof fn !== 'function') {
    throw new Error(
      `contractSnapshot: entry export ${JSON.stringify(entryRef.exportName)} not callable`,
    );
  }

  let rejection: ContractRejection | null = null;
  try {
    (fn as () => void)();
    trace.push({ kind: 'exit_ok' });
  } catch (err) {
    if (err instanceof WasiCleanExit) {
      // The WASI shim's `proc_exit(0)` path: MockSequenceEnv.reject already
      // pushed `exit_ok` before throwing this sentinel. Nothing more to do.
    } else if (err instanceof ContractRejection) {
      rejection = err;
      trace.push({ kind: 'rejected', reason: err.message });
    } else {
      // Non-rejection error (sequence mismatch, runtime trap, etc.) — bubble up
      // after rendering the trace so the user sees how far execution got.
      const partial = formatTrace(trace);
      throw new Error(`${(err as Error).message}\n\n-- partial trace --\n${partial}`);
    }
  }

  // Post-run validation: every sequence entry must have been consumed.
  // For rejection: the sequence's `reject` entry, if any, was consumed by
  // MockSequenceEnv.reject() before throwing, so the cursor naturally
  // advances past it. If no reject entry was queued but the contract did
  // reject, that's an unexpected rejection — fail the test.
  if (env.sequenceCursor < options.sequence.length) {
    const unconsumed = options.sequence.length - env.sequenceCursor;
    const partial = formatTrace(trace);
    throw new Error(
      `contractSnapshot: sequence under-consumed (${unconsumed} unused entries remain after run)\n\n` +
        `-- partial trace --\n${partial}`,
    );
  }
  if (rejection !== null) {
    // Cursor was advanced to the reject entry. Verify it was actually a reject.
    const lastStep = options.sequence[options.sequence.length - 1];
    if (!lastStep || lastStep.type !== 'reject') {
      throw new Error(
        `contractSnapshot: contract rejected (${
          JSON.stringify(rejection.message)
        }) but the last sequence entry was not a reject step`,
      );
    }
  }

  const formatted = formatTrace(trace);
  await assertSnapshot(t, formatted);
}
