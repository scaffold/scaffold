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

// End-to-end: build a Block carrying the echo `.wasm` as a record,
// register it in a BlockStore-shaped lookup, and run the contract
// through ContractHost.runVerifying via the WasmContractPlugin.

async function loadFixture(name: string): Promise<Uint8Array> {
  const url = new URL(`./fixtures/wasm/${name}.wasm`, import.meta.url);
  return await Deno.readFile(url);
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
  emitOutput(verifier: Verifier, value: number, body?: Uint8Array): void {
    this.emitted.push({ verifier, value, body });
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

const LAYERS_DEFAULT = new TextEncoder().encode('[{}]');

Deno.test('wasmContractPlugin: accepts blocks with a `wasm` record', async () => {
  const wasmBytes = await loadFixture('echo');
  const block = composeGenesisPacket([
    makeRecordOutput('wasm', wasmBytes),
    makeRecordOutput('wasm_layers', LAYERS_DEFAULT),
  ]);
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  assertEquals(plugin.accepts(block), true);
});

Deno.test('wasmContractPlugin: rejects blocks without a `wasm` record', () => {
  const block = composeGenesisPacket([
    makeRecordOutput('not_wasm', new Uint8Array([1, 2, 3])),
  ]);
  const plugin = wasmContractPlugin({ transport: 'in-process' });
  assertEquals(plugin.accepts(block), false);
});

Deno.test(
  'wasmContractPlugin: getContract returns a Contract that runs end-to-end',
  async () => {
    const wasmBytes = await loadFixture('echo');
    const block = composeGenesisPacket([
      makeRecordOutput('wasm', wasmBytes),
      makeRecordOutput('wasm_layers', LAYERS_DEFAULT),
    ]);

    const plugin = wasmContractPlugin({ transport: 'in-process' });
    const host = new ContractHost<Block>({
      getBlock: (h) => (Hash.equals(h, block.hash) ? block : undefined),
    });
    host.registerPlugin(plugin);

    // ContractHost.runVerifying builds its own VerifyingEnv from the
    // provider, so it can't observe a `RecordingEnv`. Instead pull the
    // plugin-resolved Contract out via getContract and drive it directly
    // with a recording env -- this is what the higher-level
    // VerificationService does internally.
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
    const wasmBytes = await loadFixture('echo');
    // Two 32-byte hashes packed back-to-back -- the standard wire shape.
    const ns1 = Hash.digest('plugin-ns-A');
    const ns2 = Hash.digest('plugin-ns-B');
    const namespaceBytes = new Uint8Array(64);
    namespaceBytes.set(ns1.toBytes(), 0);
    namespaceBytes.set(ns2.toBytes(), 32);

    const block = composeGenesisPacket([
      makeRecordOutput('wasm', wasmBytes),
      makeRecordOutput('wasm_layers', LAYERS_DEFAULT),
      makeRecordOutput('output_namespaces', namespaceBytes),
    ]);

    const plugin = wasmContractPlugin({ transport: 'in-process' });
    const contract = plugin.getContract(block);
    assertEquals(contract.outputNamespaces?.length, 2);
    assertEquals(contract.outputNamespaces?.[0].toHex(), ns1.toHex());
    assertEquals(contract.outputNamespaces?.[1].toHex(), ns2.toHex());
  },
);
