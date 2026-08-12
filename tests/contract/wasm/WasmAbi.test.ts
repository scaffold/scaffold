import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { ContractRejection } from '../../../src/contract/ContractRejection.ts';
import { createSink } from '../../../src/contract/createSink.ts';
import { createSource } from '../../../src/contract/createSource.ts';
import { ContractEnv, ExecutionMode } from '../../../src/contract/env/ContractEnv.ts';
import { MapSource, ValueSink, ValueType } from '../../../src/contract/values.ts';
import { buildImports, runImports, walkImports } from '../../../src/contract/wasm/WasmAbi.ts';
import { HostImports } from '../../../src/contract/wasm/WasmTransport.ts';
import { str2bin } from '../../../src/util/buffer.ts';
import { todo } from '../../../src/util/functional.ts';
import { Hash } from '../../../src/util/Hash.ts';

const call = (imports: HostImports, name: string, ...args: unknown[]) =>
  (imports[name].call as (...a: unknown[]) => unknown)(...args);

const stubEnv = (): ContractEnv & { results: Uint8Array[] } => {
  const results: Uint8Array[] = [];
  return {
    results,
    mode: () => ExecutionMode.Generation,
    contractHash: () => Hash.digest('stub'),
    params: () => str2bin('params'),
    blockHash: () => Hash.digest('block'),
    claimOne: () => ({
      fromBlockHash: Hash.digest('block'),
      body: str2bin('claimed'),
      amount: 0n,
      blockTimestampMs: 0,
    }),
    claimAll: () => todo(),
    fetch: () => todo(),
    require: () => todo(),
    put: () => todo(),
    send: () => todo(),
    waitUntil: () => todo(),
    sign: () => todo(),
    getResult: () => str2bin('result'),
    setResult: (r) => void results.push(r),
  };
};

Deno.test('runImports wires the env surface through', () => {
  const env = stubEnv();
  const imports = runImports(env);
  assertEquals(call(imports, 'contract_hash'), Hash.digest('stub').toBytes());
  assertEquals(call(imports, 'params'), str2bin('params'));
  assertEquals(call(imports, 'claim'), str2bin('claimed'));
  assertEquals(call(imports, 'get_result'), str2bin('result'));
  call(imports, 'set_result', str2bin('out'));
  assertEquals(env.results, [str2bin('out')]);
});

Deno.test('runImports reject throws ContractRejection with the reason', () => {
  assertThrows(
    () => call(runImports(stubEnv()), 'reject', 'bad input'),
    ContractRejection,
    'bad input',
  );
});

Deno.test('runImports debug never traps without a sink', () => {
  call(runImports(stubEnv()), 'debug', 'message');
});

Deno.test('runImports debug reaches the bound sink', () => {
  const messages: string[] = [];
  call(runImports(stubEnv(), (m) => messages.push(m)), 'debug', 'hi');
  assertEquals(messages, ['hi']);
});

Deno.test('walkImports drives a map into a sink', async () => {
  const value = await createSink((sink) => {
    const walker = walkImports(sink);
    call(walker.imports, 'root', '');
    assertEquals(call(walker.imports, 'begin_map'), 1);
    call(walker.imports, 'map_at', 'name', '');
    call(walker.imports, 'set_string', 'joel');
    call(walker.imports, 'end_map');
    walker.finish();
  });
  assertEquals(value, { name: 'joel' });
});

Deno.test('walkImports drives a list of scalars, length unknown', async () => {
  const value = await createSink((sink) => {
    const walker = walkImports(sink);
    call(walker.imports, 'root', '');
    assertEquals(call(walker.imports, 'begin_list', -1), 1);
    call(walker.imports, 'list_at', 0, '');
    call(walker.imports, 'set_number', 1.5);
    call(walker.imports, 'list_at', 1, '');
    call(walker.imports, 'set_bool', 0);
    call(walker.imports, 'end_list');
    walker.finish();
  });
  assertEquals(value, [1.5, false]);
});

const declineSink: ValueSink = {
  setUnit: () => {},
  setBool: () => {},
  setNumber: () => {},
  setString: () => {},
  setBytes: () => {},
  setList: () => undefined,
  setMap: () => undefined,
};

Deno.test('a declined descent returns 0 and leaves a balanced walk', () => {
  const walker = walkImports(() => declineSink);
  call(walker.imports, 'root', '');
  assertEquals(call(walker.imports, 'begin_map'), 0);
  walker.finish();
});

Deno.test('walkImports rejects an emit without a selection', async () => {
  await assertRejects(
    () => createSink((sink) => void call(walkImports(sink).imports, 'set_unit')),
    Error,
    'no sink selected',
  );
});

Deno.test('walkImports rejects selecting the root twice', async () => {
  await assertRejects(
    () =>
      createSink((sink) => {
        const walker = walkImports(sink);
        call(walker.imports, 'root', '');
        call(walker.imports, 'root', '');
      }),
    Error,
    'root already selected',
  );
});

Deno.test('walkImports rejects map_at inside a list', async () => {
  await assertRejects(
    () =>
      createSink((sink) => {
        const walker = walkImports(sink);
        call(walker.imports, 'root', '');
        call(walker.imports, 'begin_list', 2);
        call(walker.imports, 'map_at', 'key', '');
      }),
    Error,
    'not a map',
  );
});

Deno.test('finish catches a container the guest left open', async () => {
  await assertRejects(
    () =>
      createSink((sink) => {
        const walker = walkImports(sink);
        call(walker.imports, 'root', '');
        call(walker.imports, 'begin_map');
        walker.finish();
      }),
    Error,
    'left a container open',
  );
});

Deno.test('finish catches a guest that never walked', () => {
  assertThrows(() => walkImports(() => declineSink).finish(), Error, 'never selected the root');
});

Deno.test('buildImports navigates a map source', async () => {
  const imports = buildImports(() => createSource({ name: 'joel' }));
  assertEquals(await call(imports, 'root', ''), ValueType.Map);
  call(imports, 'enter');
  assertEquals(await call(imports, 'map_at', 'name', ''), ValueType.String);
  assertEquals(call(imports, 'get_string'), 'joel');
  call(imports, 'exit');
});

Deno.test('buildImports reads list length and scalar values', async () => {
  const imports = buildImports(() => createSource([1.5, true, str2bin('b')]));
  assertEquals(await call(imports, 'root', ''), ValueType.List);
  assertEquals(call(imports, 'length'), 3);
  call(imports, 'enter');
  assertEquals(await call(imports, 'list_at', 0, ''), ValueType.Number);
  assertEquals(call(imports, 'get_number'), 1.5);
  assertEquals(await call(imports, 'list_at', 1, ''), ValueType.Bool);
  assertEquals(call(imports, 'get_bool'), 1);
  assertEquals(await call(imports, 'list_at', 2, ''), ValueType.Bytes);
  assertEquals(call(imports, 'get_bytes'), str2bin('b'));
});

Deno.test('an absent source resolves to -1', async () => {
  const source: MapSource = { type: ValueType.Map, entry: () => undefined, at: () => undefined };
  const imports = buildImports(() => source);
  assertEquals(await call(imports, 'root', ''), ValueType.Map);
  call(imports, 'enter');
  assertEquals(await call(imports, 'map_at', 'missing', ''), -1);
});

Deno.test('an async source resolves through navigation', async () => {
  const source: MapSource = {
    type: ValueType.Map,
    entry: () => Promise.resolve({ key: 'key', value: createSource('deferred') }),
    at: () => Promise.resolve(createSource('deferred')),
  };
  const imports = buildImports(() => source);
  assertEquals(await call(imports, 'root', ''), ValueType.Map);
  call(imports, 'enter');
  assertEquals(await call(imports, 'map_at', 'key', ''), ValueType.String);
  assertEquals(call(imports, 'get_string'), 'deferred');
});

Deno.test('buildImports rejects a type-mismatched read', async () => {
  const imports = buildImports(() => createSource(42));
  assertEquals(await call(imports, 'root', ''), ValueType.Number);
  assertThrows(() => call(imports, 'get_string'), Error, 'not a String');
});

Deno.test('buildImports rejects entering a scalar', async () => {
  const imports = buildImports(() => createSource(42));
  await call(imports, 'root', '');
  assertThrows(() => call(imports, 'enter'), Error, 'not a container');
});

Deno.test('buildImports rejects a second root request', async () => {
  const imports = buildImports(() => createSource(1));
  await call(imports, 'root', '');
  assertThrows(() => call(imports, 'root', ''), Error, 'root already requested');
});
