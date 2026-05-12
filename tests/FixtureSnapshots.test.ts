// Snapshot tests for the simple .wat fixtures under tests/fixtures/wasm/.
// Each test exercises one fixture end-to-end through the contract-trace
// snapshot helper. The committed .snap file captures the host-call sequence
// + cross-layer hops verbatim; any drift in fixture or runtime shows up as
// a diff.
//
// Regenerate snapshots: deno test --allow-all tests/FixtureSnapshots.test.ts -- --update

import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { ExecutionMode } from '../src/core/ContractEnv.ts';
import { assertContractTraceSnapshot } from './helpers/contractSnapshot.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

async function loadFixture(name: string): Promise<{ bytes: Uint8Array; hash: Hash }> {
  const url = new URL(`./fixtures/wasm/${name}.wasm`, import.meta.url);
  const bytes = await Deno.readFile(url);
  return { bytes, hash: Hash.digest(bytes) };
}

function singleModuleGraph(hashHex: string, withScaffoldMemory = true) {
  return {
    base: withScaffoldMemory
      ? {
        version: 20250510,
        imports: { run: 'main:run' },
        memories: { heap: { initial: 16, maximum: 4096, shared: true } },
      }
      : { version: 20250510, imports: { run: 'main:run' } },
    layers: {
      main: {
        wasmHash: hashHex,
        imports: withScaffoldMemory
          ? { 'scaffold_env.*': 'base:*', 'env.memory': 'base:heap' }
          : { 'scaffold_env.*': 'base:*' },
      },
    },
  };
}

// -- echo: params -> Output{ZERO_HASH, "echo", 0, <params>} ----------

Deno.test('Fixture: echo emits params as RECORD body', async (t) => {
  const { bytes, hash } = await loadFixture('echo');
  await assertContractTraceSnapshot(t, {
    records: { modules: singleModuleGraph(hash.toHex()) },
    blobs: { [hash.toHex()]: bytes },
    mock: {
      mode: ExecutionMode.Verification,
      params: utf8('echo body bytes'),
    },
    sequence: [
      {
        type: 'emit_output',
        expect: {
          verifier: { contract: ZERO_HASH, params: utf8('echo') },
          value: 0,
          body: utf8('echo body bytes'),
        },
      },
    ],
  });
});

// -- reject_test: immediately calls reject() with a fixed reason ----

Deno.test('Fixture: reject_test produces a ContractRejection', async (t) => {
  const { bytes, hash } = await loadFixture('reject_test');
  await assertContractTraceSnapshot(t, {
    records: { modules: singleModuleGraph(hash.toHex()) },
    blobs: { [hash.toHex()]: bytes },
    mock: { mode: ExecutionMode.Verification },
    sequence: [
      { type: 'reject', expect: { reason: 'rejected on purpose' } },
    ],
  });
});

// -- rename_only: import renamed to scaffold's emit_output ----------

Deno.test('Fixture: rename_only routes a renamed namespace import to scaffold', async (t) => {
  const { bytes, hash } = await loadFixture('rename_only');
  const spec = {
    base: {
      version: 20250510,
      imports: { run: 'main:run' },
      memories: { heap: { initial: 16, maximum: 4096, shared: true } },
    },
    layers: {
      main: {
        wasmHash: hash.toHex(),
        imports: {
          'renamed_env.emit_output': 'base:emit_output',
          'env.memory': 'base:heap',
        },
      },
    },
  };
  await assertContractTraceSnapshot(t, {
    records: { modules: spec },
    blobs: { [hash.toHex()]: bytes },
    mock: { mode: ExecutionMode.Verification },
    sequence: [
      {
        type: 'emit_output',
        expect: {
          verifier: { contract: ZERO_HASH, params: utf8('rename') },
          value: 0,
          body: utf8('rename-ok'),
        },
      },
    ],
  });
});

// -- passthrough (two layers): upper imports emit_output from lower --

Deno.test('Fixture: passthrough two-layer graph forwards emit_output upward', async (t) => {
  const lower = await loadFixture('passthrough_lower');
  const upper = await loadFixture('passthrough_upper');
  const spec = {
    base: {
      version: 20250510,
      imports: { run: 'upper:run' },
      memories: { heap: { initial: 16, maximum: 4096, shared: true } },
    },
    layers: {
      lower: {
        wasmHash: lower.hash.toHex(),
        imports: {
          'scaffold_env.emit_output': 'base:emit_output',
          'env.memory': 'base:heap',
        },
      },
      upper: {
        wasmHash: upper.hash.toHex(),
        imports: {
          'renamed_ns.emit_output': 'lower:emit_output',
          'env.memory': 'base:heap',
        },
      },
    },
  };
  await assertContractTraceSnapshot(t, {
    records: { modules: spec },
    blobs: {
      [lower.hash.toHex()]: lower.bytes,
      [upper.hash.toHex()]: upper.bytes,
    },
    mock: { mode: ExecutionMode.Verification },
    sequence: [
      {
        type: 'emit_output',
        expect: {
          verifier: { contract: ZERO_HASH, params: utf8('stack') },
          value: 0,
          body: utf8('passthrough-ok'),
        },
      },
    ],
  });
});

// -- own_memory_echo: module exports its own memory ------------------

Deno.test('Fixture: own_memory_echo runs without a scaffold-provided memory', async (t) => {
  const { bytes, hash } = await loadFixture('own_memory_echo');
  await assertContractTraceSnapshot(t, {
    records: { modules: singleModuleGraph(hash.toHex(), /* withScaffoldMemory */ false) },
    blobs: { [hash.toHex()]: bytes },
    mock: {
      mode: ExecutionMode.Verification,
      params: utf8('own-mem'),
    },
    sequence: [
      {
        type: 'emit_output',
        expect: {
          verifier: { contract: ZERO_HASH, params: utf8('echo') },
          value: 0,
          body: utf8('own-mem'),
        },
      },
    ],
  });
});

// -- cross-memory: consumer imports data_owner's memory --------------

Deno.test('Fixture: cross_mem_consumer reads data_owner exported memory', async (t) => {
  const owner = await loadFixture('data_owner');
  const consumer = await loadFixture('cross_mem_consumer');
  const spec = {
    base: { version: 20250510, imports: { run: 'consumer:run' } },
    layers: {
      owner: { wasmHash: owner.hash.toHex() },
      consumer: {
        wasmHash: consumer.hash.toHex(),
        imports: {
          'scaffold_env.emit_output': 'base:emit_output',
          'other_mem.memory': 'owner:memory',
        },
      },
    },
  };
  await assertContractTraceSnapshot(t, {
    records: { modules: spec },
    blobs: {
      [owner.hash.toHex()]: owner.bytes,
      [consumer.hash.toHex()]: consumer.bytes,
    },
    mock: { mode: ExecutionMode.Verification },
    sequence: [
      {
        type: 'emit_output',
        expect: {
          // The consumer emits Output{ZERO_HASH, "", 0, "hello-from-data-owner"}
          // -- consumer.wat writes params length = 0 at offset 1056.
          verifier: { contract: ZERO_HASH, params: new Uint8Array(0) },
          value: 0,
          body: utf8('hello-from-data-owner'),
        },
      },
    ],
  });
});
