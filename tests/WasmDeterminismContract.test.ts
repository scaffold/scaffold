// Integration test for the wasm-determinism Scaffold contract.
//
// The contract wraps the existing transform logic and runs via the standard
// WasmContractPlugin pathway. We build two contract blocks that reference the
// same contract WASM blob but differ in their `scaffold-determinism-mode`
// record on the contract's own block: one transform, one verify.

import { assert, assertEquals, assertRejects } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { composeGenesisPacket, HASH_CONTRACT, RECORD_CONTRACT } from '../src/core/Block.ts';
import { makeRecordOutput } from '../src/contracts/RecordContract.ts';
import { ContractHost } from '../src/core/ContractHost.ts';
import type { Output, Verifier } from '../src/core/BlockCreationModule.ts';
import {
  type Claim,
  type ContractEnv,
  ContractRejection,
  ExecutionMode,
} from '../src/core/ContractEnv.ts';
import { wasmContractPlugin } from '../src/plugins/wasm/WasmContractPlugin.ts';
import type { Block } from '../src/core/Block.ts';
import { str2bin } from '../src/util/buffer.ts';

const CONTRACT_WASM_PATH = new URL(
  '../scripts/wasm-determinism/bin/wasm-determinism-contract.wasm',
  import.meta.url,
);
const FIXTURES_DIR = new URL('./fixtures/wasm-determinism/', import.meta.url);

async function loadContractWasm(): Promise<Uint8Array> {
  return await Deno.readFile(CONTRACT_WASM_PATH);
}

async function loadFixture(name: string): Promise<Uint8Array> {
  return await Deno.readFile(new URL(`${name}.wasm`, FIXTURES_DIR));
}

function modulesRecord(spec: unknown): Output {
  return makeRecordOutput('modules', new TextEncoder().encode(JSON.stringify(spec)));
}

function singleModuleSpec(hashHex: string): unknown {
  return {
    base: {
      version: 20250510,
      imports: { run: 'main:run' },
      memories: { heap: { initial: 16, maximum: 4096, shared: true } },
    },
    layers: {
      main: {
        wasmHash: hashHex,
        imports: { 'scaffold_env.*': 'base:*', 'env.memory': 'base:heap' },
      },
    },
  };
}

// Build a contract introducing block that owns one mode (transform or verify).
async function buildContractBlock(mode: 'transform' | 'verify'): Promise<{
  block: Block;
  contractWasm: Uint8Array;
  contractWasmHash: Hash;
}> {
  const contractWasm = await loadContractWasm();
  const contractWasmHash = Hash.digest(contractWasm);
  const namespaceBytes = new Uint8Array(32);
  namespaceBytes.set(RECORD_CONTRACT.toBytes(), 0);
  const block = composeGenesisPacket([
    modulesRecord(singleModuleSpec(contractWasmHash.toHex())),
    makeRecordOutput('output_namespaces', namespaceBytes),
    makeRecordOutput('scaffold-determinism-mode', str2bin(mode)),
  ]);
  return { block, contractWasm, contractWasmHash };
}

// Minimal ContractEnv that returns supplied params, fetches input bytes from a
// pre-built map, and lets the test inspect emissions.
class FakeEnv implements ContractEnv {
  readonly mode = ExecutionMode.Generation;
  readonly emitted: Output[] = [];
  rejection: string | null = null;

  constructor(
    private readonly contractBlock: Block,
    private readonly _params: Uint8Array,
    private readonly _modeRecord: string,
    private readonly _fetchTable: Map<string, Uint8Array>,
  ) {}

  contractHash(): Hash {
    return this.contractBlock.hash;
  }

  contractMetadata(verifier: Verifier): { value: number; body: Uint8Array } {
    if (!Hash.equals(verifier.contract, RECORD_CONTRACT)) {
      throw new ContractRejection(
        `unexpected contractMetadata verifier: ${verifier.contract.toHex()}`,
      );
    }
    const key = new TextDecoder().decode(verifier.params);
    if (key !== 'scaffold-determinism-mode') {
      throw new ContractRejection(`unexpected contractMetadata key: ${key}`);
    }
    return { value: 0, body: str2bin(this._modeRecord) };
  }

  params(): Uint8Array {
    return this._params;
  }

  fetch(verifier: Verifier, key: Uint8Array): Uint8Array {
    if (!Hash.equals(verifier.contract, HASH_CONTRACT)) {
      throw new ContractRejection(`unexpected fetch verifier: ${verifier.contract.toHex()}`);
    }
    const keyStr = new TextDecoder().decode(key);
    if (keyStr !== 'default') {
      throw new ContractRejection(`unexpected fetch key: ${keyStr}`);
    }
    const k = Hash.fromBytes(verifier.params).toHex();
    const bytes = this._fetchTable.get(k);
    if (!bytes) throw new ContractRejection(`fetch: no bytes for hash ${k}`);
    return bytes;
  }

  emitOutput(verifier: Verifier, value: number, body?: Uint8Array): void {
    this.emitted.push({ verifier, value, body });
  }

  // unused on this contract path
  claimAll(): Claim[] {
    return [];
  }
  claimNext(): Claim {
    throw new ContractRejection('no inputs');
  }
  requestBody(): { value: number; body: Uint8Array } {
    throw new ContractRejection('not used');
  }
  record(): void {
    throw new ContractRejection('not used');
  }
  sign(): void {}
  fork(): void {}
  timestamp(): number {
    return 0;
  }
}

async function runWith(
  mode: 'transform' | 'verify',
  inputFixtureName: string,
): Promise<FakeEnv> {
  const { block, contractWasm, contractWasmHash } = await buildContractBlock(mode);
  const inputBytes = await loadFixture(inputFixtureName);
  const inputHash = Hash.digest(inputBytes);
  const fetchTable = new Map<string, Uint8Array>();
  fetchTable.set(inputHash.toHex(), inputBytes);

  const plugin = wasmContractPlugin({
    transport: 'in-process',
    resolveBlob: (h: Hash) => {
      if (Hash.equals(h, contractWasmHash)) return Promise.resolve(contractWasm);
      return Promise.reject(new Error(`unexpected blob ${h.toHex()}`));
    },
  });
  const host = new ContractHost<Block>({
    getBlock: (h) => (Hash.equals(h, block.hash) ? block : undefined),
  });
  host.registerPlugin(plugin);
  const contract = host.getContract(block.hash);
  assert(contract !== undefined);

  const env = new FakeEnv(block, inputHash.toBytes(), mode, fetchTable);
  await contract!.run(env);
  return env;
}

// -------------------- transform mode --------------------

Deno.test('transform mode: clean input emits only "default" with input hash', async () => {
  const env = await runWith('transform', 'clean');
  assertEquals(env.emitted.length, 1, 'expected one emitted output');
  const out = env.emitted[0];
  assert(Hash.equals(out.verifier.contract, RECORD_CONTRACT));
  assertEquals(new TextDecoder().decode(out.verifier.params), 'default');
  assertEquals(out.value, 0);
  assert(out.body !== undefined);
  // The body is the input hash (no-op output_hash == input_hash).
  const inputBytes = await loadFixture('clean');
  assertEquals(Hash.fromBytes(out.body!).toHex(), Hash.digest(inputBytes).toHex());
});

Deno.test('transform mode: non-clean input emits "default" + "outputWasmBytes"', async () => {
  const env = await runWith('transform', 'memory_section');
  assertEquals(env.emitted.length, 2, 'expected two emitted outputs');

  const byKey = new Map<string, Output>();
  for (const o of env.emitted) {
    byKey.set(new TextDecoder().decode(o.verifier.params), o);
  }

  const defaultOut = byKey.get('default');
  assert(defaultOut !== undefined, 'missing default record');
  const bytesOut = byKey.get('outputWasmBytes');
  assert(bytesOut !== undefined, 'missing outputWasmBytes record');

  // The default body is the hash of the bytes record body.
  const computedHash = Hash.digest(bytesOut!.body!);
  assertEquals(Hash.fromBytes(defaultOut!.body!).toHex(), computedHash.toHex());
});

Deno.test('transform mode: banned input rejects', async () => {
  await assertRejects(
    () => runWith('transform', 'banned_reinterpret'),
    ContractRejection,
    'banned WASM content',
  );
});

// -------------------- verify mode --------------------

Deno.test('verify mode: clean input accepts (no emissions)', async () => {
  const env = await runWith('verify', 'clean');
  assertEquals(env.emitted.length, 0);
});

Deno.test('verify mode: non-clean input rejects', async () => {
  await assertRejects(
    () => runWith('verify', 'memory_section'),
    ContractRejection,
    'not already deterministic',
  );
});

Deno.test('verify mode: banned input rejects', async () => {
  await assertRejects(
    () => runWith('verify', 'banned_atomic'),
    ContractRejection,
    'banned WASM content',
  );
});

// -------------------- idempotence check --------------------

Deno.test('transform mode output passes verify (idempotence)', async () => {
  // Transform memory_section, then verify the resulting bytes.
  const transformedEnv = await runWith('transform', 'memory_section');
  const bytesOut = transformedEnv.emitted.find(
    (o) => new TextDecoder().decode(o.verifier.params) === 'outputWasmBytes',
  );
  assert(bytesOut !== undefined);
  const transformedBytes = bytesOut!.body!;
  const transformedHash = Hash.digest(transformedBytes);

  // Build a verify-mode block + env that fetches the transformed bytes.
  const { block, contractWasm, contractWasmHash } = await buildContractBlock('verify');
  const fetchTable = new Map<string, Uint8Array>();
  fetchTable.set(transformedHash.toHex(), transformedBytes);

  const plugin = wasmContractPlugin({
    transport: 'in-process',
    resolveBlob: (h: Hash) => {
      if (Hash.equals(h, contractWasmHash)) return Promise.resolve(contractWasm);
      return Promise.reject(new Error(`unexpected blob ${h.toHex()}`));
    },
  });
  const host = new ContractHost<Block>({
    getBlock: (h) => (Hash.equals(h, block.hash) ? block : undefined),
  });
  host.registerPlugin(plugin);
  const contract = host.getContract(block.hash);
  const env = new FakeEnv(block, transformedHash.toBytes(), 'verify', fetchTable);
  await contract!.run(env);
  assertEquals(env.emitted.length, 0, 'verify of transformed bytes should accept silently');
});
