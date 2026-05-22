import { assertEquals } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { composeGenesisPacket } from '../src/core/Block.ts';
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

// End-to-end: build a Block whose `modules` record references the echo blob
// by content hash; resolveBlob returns the bytes; ContractHost dispatches to
// the plugin and runs the contract against a recording env.

async function loadFixtureBytes(name: string): Promise<Uint8Array> {
  const url = new URL(`./fixtures/wasm/${name}.wasm`, import.meta.url);
  return await Deno.readFile(url);
}

function modulesRecord(spec: unknown): Output {
  return makeRecordOutput('modules', new TextEncoder().encode(JSON.stringify(spec)));
}

/** Build a minimal `modules` spec for a single-module contract. */
function singleModuleSpec(hashHex: string, mode: string, entry: string): unknown {
  return {
    base: {
      version: 20250510,
      imports: { [mode]: `main:${entry}` },
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

class RecordingEnv implements ContractEnv {
  readonly mode = ExecutionMode.Verification;
  readonly emitted: Output[] = [];
  constructor(private readonly _params: Uint8Array) {}
  contractHash(): Hash {
    return Hash.digest('echo-contract-test');
  }
  contractMetadata(): { value: number; body: Uint8Array } {
    throw new ContractRejection('not used in tests');
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
  send(verifier: Verifier, value: number, body?: Uint8Array): void {
    this.emitted.push({ verifier, value, body });
  }
  request(): { value: number; body: Uint8Array } {
    throw new ContractRejection('no body resolver');
  }
  record(): void {
    throw new ContractRejection('not used');
  }
  fetch(): Uint8Array {
    throw new ContractRejection('no fetch');
  }
  sign(): void {}
  put(): void {}
  timestamp(): number {
    return 0;
  }
}

Deno.test('wasmContractPlugin: accepts blocks with a modules record', async () => {
  const bytes = await loadFixtureBytes('echo');
  const hash = Hash.digest(bytes);
  const block = composeGenesisPacket([modulesRecord(singleModuleSpec(hash.toHex(), 'run', 'run'))]);
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  assertEquals(plugin.accepts(block), true);
});

Deno.test('wasmContractPlugin: rejects blocks without a modules record', () => {
  const block = composeGenesisPacket([
    makeRecordOutput('something_else', new Uint8Array([1, 2, 3])),
  ]);
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  assertEquals(plugin.accepts(block), false);
});

Deno.test(
  'wasmContractPlugin: getContract runs end-to-end via resolveBlob',
  async () => {
    const bytes = await loadFixtureBytes('echo');
    const hash = Hash.digest(bytes);
    const block = composeGenesisPacket([
      modulesRecord(singleModuleSpec(hash.toHex(), 'run', 'run')),
    ]);

    const plugin = wasmContractPlugin({
      transport: 'in-process',
      resolveBlob: (h: Hash) => {
        if (Hash.equals(h, hash)) return Promise.resolve(bytes);
        return Promise.reject(new Error(`unexpected blob ${h.toHex()}`));
      },
    });
    const host = new ContractHost<Block>({
      getBlock: (h) => (Hash.equals(h, block.hash) ? block : undefined),
    });
    host.registerPlugin(plugin);

    const contract = host.getContract(block.hash);
    assertEquals(contract === undefined, false);

    const env = new RecordingEnv(new TextEncoder().encode('hello plugin'));
    await contract!.run(env);

    assertEquals(env.emitted.length, 1);
    const emitted = env.emitted[0];
    assertEquals(emitted.verifier.contract.toHex(), ZERO_HASH.toHex());
    assertEquals(new TextDecoder().decode(emitted.verifier.params), 'echo');
    assertEquals(emitted.value, 0);
    assertEquals(new TextDecoder().decode(emitted.body ?? new Uint8Array(0)), 'hello plugin');
  },
);

Deno.test(
  'wasmContractPlugin: outputNamespaces parsed from contract block record',
  async () => {
    const bytes = await loadFixtureBytes('echo');
    const hash = Hash.digest(bytes);
    const ns1 = Hash.digest('plugin-ns-A');
    const ns2 = Hash.digest('plugin-ns-B');
    const namespaceBytes = new Uint8Array(64);
    namespaceBytes.set(ns1.toBytes(), 0);
    namespaceBytes.set(ns2.toBytes(), 32);

    const block = composeGenesisPacket([
      modulesRecord(singleModuleSpec(hash.toHex(), 'run', 'run')),
      makeRecordOutput('output_namespaces', namespaceBytes),
    ]);

    const plugin = wasmContractPlugin({ transport: 'in-process' });
    const contract = plugin.getContract(block);
    assertEquals(contract.outputNamespaces?.length, 2);
    assertEquals(contract.outputNamespaces?.[0].toHex(), ns1.toHex());
    assertEquals(contract.outputNamespaces?.[1].toHex(), ns2.toHex());
  },
);
