// End-to-end tests for WASM stacking (A4). Drives multi-layer stacks
// through `wasmContractPlugin` -> the in-process transport. Covers the
// passthrough fixture stack, mapImports renaming, mapExports namespace
// injection, and structural rejection of malformed `wasm_layers` records.

import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { composeGenesisPacket } from '../src/core/Block.ts';
import { makeRecordOutput } from '../src/contracts/RecordContract.ts';
import { wasmContractPlugin } from '../src/plugins/wasm/WasmContractPlugin.ts';
import type { Output, Verifier } from '../src/core/BlockCreationModule.ts';
import {
  type Claim,
  type ContractEnv,
  ContractRejection,
  ExecutionMode,
} from '../src/core/ContractEnv.ts';
import type { Block } from '../src/core/Block.ts';

async function loadFixtureBytes(name: string): Promise<Uint8Array> {
  const url = new URL(`./fixtures/wasm/${name}.wasm`, import.meta.url);
  return await Deno.readFile(url);
}

function makeLayersRecord(spec: unknown): Output {
  return makeRecordOutput('wasm_layers', new TextEncoder().encode(JSON.stringify(spec)));
}

function makeLayersRecordRaw(raw: string | undefined): Output | undefined {
  if (raw === undefined) return undefined;
  return makeRecordOutput('wasm_layers', new TextEncoder().encode(raw));
}

class RecordingEnv implements ContractEnv {
  readonly mode = ExecutionMode.Verification;
  readonly emittedOutputs: Output[] = [];
  constructor(private readonly _params: Uint8Array = new Uint8Array(0)) {}
  contractHash(): Hash {
    return Hash.digest('stacking-test-contract');
  }
  contractMetadata(): { value: number; body: Uint8Array } {
    throw new ContractRejection('not used');
  }
  params(): Uint8Array {
    return this._params;
  }
  claimAll(): Claim[] {
    return [];
  }
  claimNext(): Claim {
    throw new ContractRejection('no inputs');
  }
  emitOutput(verifier: Verifier, value: number, body?: Uint8Array): void {
    this.emittedOutputs.push({ verifier, value, body });
  }
  requestBody(): { value: number; body: Uint8Array } {
    throw new ContractRejection('no body resolver');
  }
  record(): void {
    throw new ContractRejection('not used');
  }
  fetch(): Uint8Array {
    throw new ContractRejection('no fetch');
  }
  sign(): void {}
  fork(): void {}
  timestamp(): number {
    return 0;
  }
}

function blobResolver(map: Map<string, Uint8Array>): (h: Hash) => Promise<Uint8Array> {
  return (h: Hash) => {
    const bytes = map.get(h.toHex().toLowerCase());
    if (bytes === undefined) return Promise.reject(new Error(`unknown blob ${h.toHex()}`));
    return Promise.resolve(bytes);
  };
}

// -- Happy path: real stack runs end-to-end ---------------------------

Deno.test(
  'WasmStacking: passthrough_upper above passthrough_lower runs end-to-end',
  async () => {
    const lowerBytes = await loadFixtureBytes('passthrough_lower');
    const upperBytes = await loadFixtureBytes('passthrough_upper');
    const lowerHash = Hash.digest(lowerBytes);
    const upperHash = Hash.digest(upperBytes);

    const block = composeGenesisPacket([
      makeLayersRecord([
        { wasmHash: lowerHash.toHex() },
        { wasmHash: upperHash.toHex(), mapImports: { 'renamed_ns.emit_output': 'emit_output' } },
      ]),
    ]);

    const resolveBlob = blobResolver(
      new Map([
        [lowerHash.toHex(), lowerBytes],
        [upperHash.toHex(), upperBytes],
      ]),
    );
    const plugin = wasmContractPlugin({ transport: 'in-process', resolveBlob });
    const contract = plugin.getContract(block);
    const env = new RecordingEnv();
    await contract.run(env);

    assertEquals(env.emittedOutputs.length, 1);
    const out = env.emittedOutputs[0];
    assertEquals(out.verifier.contract.toHex(), ZERO_HASH.toHex());
    assertEquals(new TextDecoder().decode(out.verifier.params), 'stack');
    assertEquals(out.value, 0);
    assertEquals(new TextDecoder().decode(out.body ?? new Uint8Array(0)), 'passthrough-ok');
  },
);

Deno.test(
  'WasmStacking: passthrough stack via lower-side mapExports (no upper mapImports)',
  async () => {
    // Same stack but instead of the upper specifying mapImports, the lower
    // specifies mapExports that injects "renamed_ns.emit_output" into its
    // presented view. The upper's default-1:1 lookup then resolves directly.
    const lowerBytes = await loadFixtureBytes('passthrough_lower');
    const upperBytes = await loadFixtureBytes('passthrough_upper');
    const lowerHash = Hash.digest(lowerBytes);
    const upperHash = Hash.digest(upperBytes);

    const block = composeGenesisPacket([
      makeLayersRecord([
        { wasmHash: lowerHash.toHex(), mapExports: { 'renamed_ns.emit_output': 'emit_output' } },
        { wasmHash: upperHash.toHex() },
      ]),
    ]);

    const resolveBlob = blobResolver(
      new Map([
        [lowerHash.toHex(), lowerBytes],
        [upperHash.toHex(), upperBytes],
      ]),
    );
    const plugin = wasmContractPlugin({ transport: 'in-process', resolveBlob });
    const contract = plugin.getContract(block);
    const env = new RecordingEnv();
    await contract.run(env);
    assertEquals(env.emittedOutputs.length, 1);
    assertEquals(new TextDecoder().decode(env.emittedOutputs[0].verifier.params), 'stack');
  },
);

Deno.test(
  'WasmStacking: single-module rename_only resolves via mapImports',
  async () => {
    const bytes = await loadFixtureBytes('rename_only');
    const hash = Hash.digest(bytes);
    const block = composeGenesisPacket([
      makeLayersRecord([
        {
          wasmHash: hash.toHex(),
          mapImports: { 'renamed_env.emit_output': 'emit_output' },
        },
      ]),
    ]);
    const resolveBlob = blobResolver(new Map([[hash.toHex(), bytes]]));
    const plugin = wasmContractPlugin({ transport: 'in-process', resolveBlob });
    const contract = plugin.getContract(block);
    const env = new RecordingEnv();
    await contract.run(env);
    assertEquals(env.emittedOutputs.length, 1);
    assertEquals(new TextDecoder().decode(env.emittedOutputs[0].verifier.params), 'rename');
    assertEquals(
      new TextDecoder().decode(env.emittedOutputs[0].body ?? new Uint8Array(0)),
      'rename-ok',
    );
  },
);

Deno.test(
  'WasmStacking: single-module with default 1:1 falls back to bare field on scaffold flat',
  async () => {
    // The echo fixture imports (scaffold_env, params) and (scaffold_env,
    // emit_output). With no mapImports, the resolver tries "scaffold_env.X"
    // first (not in scaffold flat), then falls back to "X" (which IS in the
    // flat scaffold view). This is the back-compat path.
    const bytes = await loadFixtureBytes('echo');
    const hash = Hash.digest(bytes);
    const block = composeGenesisPacket([
      makeLayersRecord([{ wasmHash: hash.toHex() }]),
    ]);
    const resolveBlob = blobResolver(new Map([[hash.toHex(), bytes]]));
    const plugin = wasmContractPlugin({ transport: 'in-process', resolveBlob });
    const contract = plugin.getContract(block);
    const env = new RecordingEnv(new TextEncoder().encode('default-path-ok'));
    await contract.run(env);
    assertEquals(env.emittedOutputs.length, 1);
    assertEquals(new TextDecoder().decode(env.emittedOutputs[0].verifier.params), 'echo');
  },
);

// -- Structural rejection ---------------------------------------------

function blockWith(record: Output | undefined): Block {
  return composeGenesisPacket(record ? [record] : []);
}

Deno.test('WasmStacking: reject -- missing wasm_layers record', () => {
  const block = blockWith(undefined);
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  try {
    plugin.getContract(block);
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, 'wasm_layers');
  }
});

Deno.test('WasmStacking: reject -- wasm_layers not a JSON array', () => {
  const block = blockWith(makeLayersRecordRaw('{}'));
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  try {
    plugin.getContract(block);
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, 'JSON array');
  }
});

Deno.test('WasmStacking: reject -- empty wasm_layers array', () => {
  const block = blockWith(makeLayersRecordRaw('[]'));
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  try {
    plugin.getContract(block);
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, 'non-empty');
  }
});

Deno.test('WasmStacking: reject -- entry missing wasmHash', () => {
  const block = blockWith(makeLayersRecordRaw('[{}]'));
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  try {
    plugin.getContract(block);
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, 'wasmHash is required');
  }
});

Deno.test('WasmStacking: reject -- wasmHash is not 64-char hex', () => {
  const block = blockWith(makeLayersRecord([{ wasmHash: 'not-a-hash' }]));
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  try {
    plugin.getContract(block);
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, '64-char hex');
  }
});

Deno.test('WasmStacking: reject -- duplicate wasmHash', () => {
  const dup = '0'.repeat(64);
  const block = blockWith(makeLayersRecord([{ wasmHash: dup }, { wasmHash: dup }]));
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  try {
    plugin.getContract(block);
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, 'duplicate');
  }
});

Deno.test('WasmStacking: reject -- mapImports key is env.memory', () => {
  const block = blockWith(
    makeLayersRecord([{ wasmHash: '0'.repeat(64), mapImports: { 'env.memory': 'anything' } }]),
  );
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  try {
    plugin.getContract(block);
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, 'env.memory');
  }
});

Deno.test('WasmStacking: reject -- mapImports key missing dot', () => {
  const block = blockWith(
    makeLayersRecord([{ wasmHash: '0'.repeat(64), mapImports: { 'no_dot': 'x' } }]),
  );
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  try {
    plugin.getContract(block);
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, 'dotted');
  }
});

Deno.test('WasmStacking: reject -- mapExports key missing dot', () => {
  const block = blockWith(
    makeLayersRecord([{ wasmHash: '0'.repeat(64), mapExports: { 'no_dot': 'x' } }]),
  );
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  try {
    plugin.getContract(block);
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, 'dotted');
  }
});

Deno.test('WasmStacking: reject -- resolveBlob missing', async () => {
  const bytes = await loadFixtureBytes('echo');
  const hash = Hash.digest(bytes);
  const block = composeGenesisPacket([makeLayersRecord([{ wasmHash: hash.toHex() }])]);
  // No resolveBlob.
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  const contract = plugin.getContract(block);
  await assertRejects(
    async () => {
      await contract.run(new RecordingEnv());
    },
    Error,
    'resolveBlob',
  );
});

Deno.test('WasmStacking: LinkError surfaces for genuinely unresolved import', async () => {
  // rename_only declares (import "renamed_env" "emit_output" ...). With NO
  // mapImports, default lookup tries "renamed_env.emit_output" then bare
  // "emit_output". The scaffold flat view has emit_output, so this resolves
  // fine. Build a deliberately broken case: rename to something the scaffold
  // doesn't expose.
  const bytes = await loadFixtureBytes('rename_only');
  const hash = Hash.digest(bytes);
  const block = composeGenesisPacket([
    makeLayersRecord([
      {
        wasmHash: hash.toHex(),
        mapImports: { 'renamed_env.emit_output': 'definitely_not_a_scaffold_name' },
      },
    ]),
  ]);
  const resolveBlob = blobResolver(new Map([[hash.toHex(), bytes]]));
  const plugin = wasmContractPlugin({ transport: 'in-process', resolveBlob });
  const contract = plugin.getContract(block);
  await assertRejects(
    async () => {
      await contract.run(new RecordingEnv());
    },
    Error,
  );
  // We don't pin the exact LinkError message; it varies by runtime, but
  // SOME error must fire.
  assert(true);
});
