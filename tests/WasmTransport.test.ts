import { assertEquals, assertRejects } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import type { Output, Verifier } from '../src/core/BlockCreationModule.ts';
import {
  type Claim,
  type ContractEnv,
  ContractRejection,
  ExecutionMode,
} from '../src/core/ContractEnv.ts';
import type { ValueDescriptor, WalkerHost } from '../src/contracts/Contract.ts';
import { createReader } from '../src/interfaces/Reader.ts';
import type { WasmTransport } from '../src/plugins/wasm/WasmTransport.ts';
import { InProcessMockTransport } from '../src/plugins/wasm/transports/InProcessMockTransport.ts';
import { JspiTransport } from '../src/plugins/wasm/transports/JspiTransport.ts';
import { AtomicsWorkerTransport } from '../src/plugins/wasm/transports/AtomicsWorkerTransport.ts';

// -- Fixtures ------------------------------------------------------

import {
  type CompiledLayer,
  type CompiledModules,
  parseModules,
} from '../src/plugins/wasm/WasmModules.ts';

/**
 * Wrap a single fixture module as a one-layer CompiledModules. Every fixture
 * imports `scaffold_X.*` names; the wildcard rule maps each to `base:*` so
 * the strict resolution finds them in the scaffold flat view.
 */
async function singleModuleStack(
  name: string,
  mode: 'run' | 'walk_params' | 'walk_data' | 'build_params' | 'build_data',
  entryExport: string,
): Promise<CompiledModules> {
  const url = new URL(`./fixtures/wasm/${name}.wasm`, import.meta.url);
  const bytes = await Deno.readFile(url);
  const hash = Hash.digest(bytes);
  const spec = {
    base: {
      version: 20250510,
      imports: { [mode]: `main:${entryExport}` },
      memories: { heap: { initial: 16, maximum: 4096, shared: true } },
    },
    layers: [
      {
        key: 'main',
        wasmHash: hash.toHex(),
        imports: {
          'scaffold_env.*': 'base:*',
          'scaffold_walker.*': 'base:*',
          'scaffold_builder.*': 'base:*',
          'env.memory': 'base:heap',
        },
      },
    ],
  };
  const normalised = parseModules(new TextEncoder().encode(JSON.stringify(spec)));
  const module = await WebAssembly.compile(bytes);
  const layer: CompiledLayer = {
    key: 'main',
    module,
    imports: normalised.layers[0].imports,
  };
  return {
    base: normalised.base,
    layers: [layer],
    byKey: new Map([['main', layer]]),
  };
}

// -- Mock env / hosts ---------------------------------------------

/** Recording env: synchronous; captures send calls verbatim. */
class RecordingEnv implements ContractEnv {
  readonly mode = ExecutionMode.Verification;
  readonly emittedOutputs: Output[] = [];
  readonly signedKeys: Uint8Array[] = [];

  constructor(private readonly _params: Uint8Array) {}

  contractHash(): Hash {
    return Hash.digest('test-contract');
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
    this.emittedOutputs.push({ verifier, value, body });
  }

  request(): { value: number; body: Uint8Array } {
    throw new ContractRejection('no body resolver');
  }

  record(_key: Uint8Array, _value: Uint8Array): void {
    throw new ContractRejection('record() not exercised in tests');
  }

  fetch(): Uint8Array {
    throw new ContractRejection('no fetch resolver');
  }

  sign(pubkey: Uint8Array): void {
    this.signedKeys.push(pubkey);
  }

  put(): Hash {
    throw new ContractRejection('put not supported in tests');
  }

  timestamp(): number {
    return 1_234_567_890;
  }
}

class RecordingWalker implements WalkerHost {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  emitBytes(key: string, value: Uint8Array, desc: ValueDescriptor): void {
    this.calls.push({ method: 'emitBytes', args: [key, value, desc] });
  }
  emitString(key: string, value: string, desc: ValueDescriptor): void {
    this.calls.push({ method: 'emitString', args: [key, value, desc] });
  }
  emitNumber(key: string, value: number, desc: ValueDescriptor): void {
    this.calls.push({ method: 'emitNumber', args: [key, value, desc] });
  }
  emitBool(key: string, value: boolean, desc: ValueDescriptor): void {
    this.calls.push({ method: 'emitBool', args: [key, value, desc] });
  }
  emitMapStart(_key: string): boolean {
    return true;
  }
  emitMapEnd(): void {}
  emitListStart(_key: string, _count: number): boolean {
    return true;
  }
  emitListEnd(): void {}
}

// -- Transport factory --------------------------------------------

interface TransportEntry {
  name: string;
  available: boolean;
  create(): WasmTransport;
}

function transportEntries(): TransportEntry[] {
  return [
    {
      name: 'InProcessMockTransport',
      available: true,
      create: () => new InProcessMockTransport(),
    },
    {
      name: 'JspiTransport',
      available: JspiTransport.isSupported(),
      create: () => new JspiTransport(),
    },
    {
      name: 'AtomicsWorkerTransport',
      available: typeof Worker !== 'undefined',
      create: () =>
        new AtomicsWorkerTransport({
          workerPath: new URL('../src/worker/wasm/wasmWorker.ts', import.meta.url),
          poolSize: 2,
        }),
    },
  ];
}

// -- Parameterised tests ------------------------------------------

for (const entry of transportEntries()) {
  const tag = entry.available ? entry.name : `${entry.name} (skipped)`;
  const ignore = !entry.available;

  Deno.test({
    name: `${tag}: run echo contract`,
    ignore,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const transport = entry.create();
      try {
        const modules = await singleModuleStack('echo', 'run', 'run');
        const env = new RecordingEnv(new TextEncoder().encode('hello world'));
        await transport.run(modules, env);
        assertEquals(env.emittedOutputs.length, 1);
        const out = env.emittedOutputs[0];
        assertEquals(out.verifier.contract.toHex(), ZERO_HASH.toHex());
        assertEquals(new TextDecoder().decode(out.verifier.params), 'echo');
        assertEquals(out.value, 0);
        assertEquals(new TextDecoder().decode(out.body ?? new Uint8Array(0)), 'hello world');
      } finally {
        await transport.close();
      }
    },
  });

  Deno.test({
    name: `${tag}: reject contract surfaces ContractRejection`,
    ignore,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const transport = entry.create();
      try {
        const modules = await singleModuleStack('reject_test', 'run', 'run');
        const env = new RecordingEnv(new Uint8Array(0));
        await assertRejects(
          () => transport.run(modules, env),
          ContractRejection,
          'rejected on purpose',
        );
        assertEquals(env.emittedOutputs.length, 0);
      } finally {
        await transport.close();
      }
    },
  });

  Deno.test({
    name: `${tag}: walk_params calls emit_string on host`,
    ignore,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const transport = entry.create();
      try {
        const modules = await singleModuleStack('walker_test', 'walk_params', 'walk_params');
        const walker = new RecordingWalker();
        await transport.walkParams(modules, new Uint8Array(0), walker);
        // AtomicsWorkerTransport routes emit_string as an inform; give the
        // microtask loop one tick to deliver the postMessage before asserting.
        await new Promise((r) => setTimeout(r, 0));
        assertEquals(walker.calls.length, 1);
        assertEquals(walker.calls[0].method, 'emitString');
        const [key, value, desc] = walker.calls[0].args as [string, string, ValueDescriptor];
        assertEquals(key, 'name');
        assertEquals(value, 'Joel');
        assertEquals(desc.type, 'string');
        assertEquals(desc.shortDescription, 'Player name');
      } finally {
        await transport.close();
      }
    },
  });

  Deno.test({
    name: `${tag}: build_params returns user-supplied string bytes`,
    ignore,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const transport = entry.create();
      try {
        const modules = await singleModuleStack('builder_test', 'build_params', 'build_params');
        const result = await transport.buildParams(modules, () => createReader({ name: 'Joel' }));
        assertEquals(new TextDecoder().decode(result), 'Joel');
      } finally {
        await transport.close();
      }
    },
  });
}
