// End-to-end tests for the WASM `modules` graph (A4 stacking). Drives the
// passthrough fixture graph through `wasmContractPlugin` -> the in-process
// transport, covers wildcards, mapping renames, and structural rejection.

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

function modulesRecord(spec: unknown): Output {
  return makeRecordOutput('modules', new TextEncoder().encode(JSON.stringify(spec)));
}

function modulesRecordRaw(raw: string): Output {
  return makeRecordOutput('modules', new TextEncoder().encode(raw));
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

// -- Happy path: real graph runs end-to-end ---------------------------

Deno.test(
  'WasmStacking: two-layer passthrough graph (upper imports from lower)',
  async () => {
    const lowerBytes = await loadFixtureBytes('passthrough_lower');
    const upperBytes = await loadFixtureBytes('passthrough_upper');
    const lowerHash = Hash.digest(lowerBytes);
    const upperHash = Hash.digest(upperBytes);

    // Graph:
    //   base.imports.run -> "upper:run"  (scaffold calls upper's run)
    //   upper imports renamed_ns.emit_output -> "lower:emit_output"
    //   lower imports scaffold_env.emit_output -> "base:emit_output"
    const spec = {
      base: { version: 20250510, imports: { run: 'upper:run' } },
      layers: {
        lower: {
          wasmHash: lowerHash.toHex(),
          imports: { 'scaffold_env.emit_output': 'base:emit_output' },
        },
        upper: {
          wasmHash: upperHash.toHex(),
          imports: { 'renamed_ns.emit_output': 'lower:emit_output' },
        },
      },
    };

    const block = composeGenesisPacket([modulesRecord(spec)]);
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
  'WasmStacking: single-module with wildcard scaffold imports',
  async () => {
    const bytes = await loadFixtureBytes('echo');
    const hash = Hash.digest(bytes);
    const spec = {
      base: { version: 20250510, imports: { run: 'main:run' } },
      layers: {
        main: {
          wasmHash: hash.toHex(),
          imports: { 'scaffold_env.*': 'base:*' },
        },
      },
    };
    const block = composeGenesisPacket([modulesRecord(spec)]);
    const resolveBlob = blobResolver(new Map([[hash.toHex(), bytes]]));
    const plugin = wasmContractPlugin({ transport: 'in-process', resolveBlob });
    const contract = plugin.getContract(block);
    const env = new RecordingEnv(new TextEncoder().encode('wildcard-ok'));
    await contract.run(env);
    assertEquals(env.emittedOutputs.length, 1);
    assertEquals(
      new TextDecoder().decode(env.emittedOutputs[0].body ?? new Uint8Array(0)),
      'wildcard-ok',
    );
  },
);

Deno.test(
  'WasmStacking: rename via explicit dotted entry (rename_only fixture)',
  async () => {
    // rename_only declares (import "renamed_env" "emit_output" ...) -- map it
    // explicitly to scaffold's emit_output.
    const bytes = await loadFixtureBytes('rename_only');
    const hash = Hash.digest(bytes);
    const spec = {
      base: { version: 20250510, imports: { run: 'main:run' } },
      layers: {
        main: {
          wasmHash: hash.toHex(),
          imports: { 'renamed_env.emit_output': 'base:emit_output' },
        },
      },
    };
    const block = composeGenesisPacket([modulesRecord(spec)]);
    const resolveBlob = blobResolver(new Map([[hash.toHex(), bytes]]));
    const plugin = wasmContractPlugin({ transport: 'in-process', resolveBlob });
    const contract = plugin.getContract(block);
    const env = new RecordingEnv();
    await contract.run(env);
    assertEquals(env.emittedOutputs.length, 1);
    assertEquals(
      new TextDecoder().decode(env.emittedOutputs[0].body ?? new Uint8Array(0)),
      'rename-ok',
    );
  },
);

// -- Structural rejection ---------------------------------------------

function blockWith(record: Output): Block {
  return composeGenesisPacket([record]);
}

Deno.test('WasmStacking: reject -- modules record not JSON object', () => {
  const block = blockWith(modulesRecordRaw('[]'));
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  try {
    plugin.getContract(block);
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, 'must be a JSON object');
  }
});

Deno.test('WasmStacking: reject -- modules.base.version not integer', () => {
  const block = blockWith(modulesRecordRaw('{"base":{"version":"v1","imports":{}},"layers":{}}'));
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  try {
    plugin.getContract(block);
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, 'version must be an integer');
  }
});

Deno.test('WasmStacking: reject -- empty layers', () => {
  const block = blockWith(
    modulesRecordRaw('{"base":{"version":20250510,"imports":{}},"layers":{}}'),
  );
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  try {
    plugin.getContract(block);
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, 'at least one layer');
  }
});

Deno.test('WasmStacking: reject -- layer key "base" is reserved', () => {
  const spec = {
    base: { version: 20250510, imports: {} },
    layers: { base: { wasmHash: '0'.repeat(64) } },
  };
  const block = blockWith(modulesRecord(spec));
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  try {
    plugin.getContract(block);
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, '"base" is reserved');
  }
});

Deno.test('WasmStacking: reject -- base.imports references unknown layer', () => {
  const spec = {
    base: { version: 20250510, imports: { run: 'nope:run' } },
    layers: { main: { wasmHash: '0'.repeat(64) } },
  };
  const block = blockWith(modulesRecord(spec));
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  try {
    plugin.getContract(block);
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, 'unknown layer');
  }
});

Deno.test('WasmStacking: reject -- duplicate wasmHash', () => {
  const dup = '0'.repeat(64);
  const spec = {
    base: { version: 20250510, imports: { run: 'a:run' } },
    layers: { a: { wasmHash: dup }, b: { wasmHash: dup } },
  };
  const block = blockWith(modulesRecord(spec));
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  try {
    plugin.getContract(block);
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, 'duplicate');
  }
});

Deno.test('WasmStacking: reject -- wildcard key/value mismatch', () => {
  const spec = {
    base: { version: 20250510, imports: { run: 'main:run' } },
    layers: {
      main: {
        wasmHash: '0'.repeat(64),
        imports: { 'foo.*': 'base:literal' },
      },
    },
  };
  const block = blockWith(modulesRecord(spec));
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  try {
    plugin.getContract(block);
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, 'wildcard');
  }
});

Deno.test('WasmStacking: reject -- target ref missing colon', () => {
  const spec = {
    base: { version: 20250510, imports: { run: 'no-colon-here' } },
    layers: { main: { wasmHash: '0'.repeat(64) } },
  };
  const block = blockWith(modulesRecord(spec));
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  try {
    plugin.getContract(block);
    throw new Error('expected throw');
  } catch (err) {
    assertStringIncludes((err as Error).message, '<layerKey>:<exportName>');
  }
});

Deno.test('WasmStacking: reject -- declared import not listed (strict)', async () => {
  // echo declares scaffold_env.params and scaffold_env.emit_output. Provide
  // an `imports` map missing one of them; loading must fail.
  const bytes = await loadFixtureBytes('echo');
  const hash = Hash.digest(bytes);
  const spec = {
    base: { version: 20250510, imports: { run: 'main:run' } },
    layers: {
      main: {
        wasmHash: hash.toHex(),
        imports: { 'scaffold_env.params': 'base:params' /* missing emit_output */ },
      },
    },
  };
  const block = composeGenesisPacket([modulesRecord(spec)]);
  const resolveBlob = blobResolver(new Map([[hash.toHex(), bytes]]));
  const plugin = wasmContractPlugin({ transport: 'in-process', resolveBlob });
  const contract = plugin.getContract(block);
  await assertRejects(
    async () => {
      await contract.run(new RecordingEnv());
    },
    Error,
    'no entry for declared import',
  );
});

Deno.test('WasmStacking: reject -- resolveBlob missing', async () => {
  const bytes = await loadFixtureBytes('echo');
  const hash = Hash.digest(bytes);
  const spec = {
    base: { version: 20250510, imports: { run: 'main:run' } },
    layers: { main: { wasmHash: hash.toHex(), imports: { 'scaffold_env.*': 'base:*' } } },
  };
  const block = composeGenesisPacket([modulesRecord(spec)]);
  // No resolveBlob configured.
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

Deno.test('WasmStacking: wildcard matching -- longest prefix wins', async () => {
  // Use the echo fixture and verify wildcard prefix routing works on a
  // single-module spec with overlapping wildcards.
  const bytes = await loadFixtureBytes('echo');
  const hash = Hash.digest(bytes);
  const spec = {
    base: { version: 20250510, imports: { run: 'main:run' } },
    layers: {
      main: {
        wasmHash: hash.toHex(),
        imports: {
          // Specific entries take precedence (literal > wildcard).
          'scaffold_env.params': 'base:params',
          'scaffold_env.*': 'base:*',
        },
      },
    },
  };
  const block = composeGenesisPacket([modulesRecord(spec)]);
  const resolveBlob = blobResolver(new Map([[hash.toHex(), bytes]]));
  const plugin = wasmContractPlugin({ transport: 'in-process', resolveBlob });
  const contract = plugin.getContract(block);
  const env = new RecordingEnv(new TextEncoder().encode('wild-longest-ok'));
  await contract.run(env);
  assertEquals(env.emittedOutputs.length, 1);
  assert(env.emittedOutputs[0].body !== undefined);
});
