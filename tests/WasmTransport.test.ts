import { assertEquals, assertRejects } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import type { Output, Verifier } from '../src/core/BlockCreationModule.ts';
import {
  type Claim,
  type ContractEnv,
  ContractRejection,
  ExecutionMode,
} from '../src/core/ContractEnv.ts';
import type { BuilderHost, ValueDescriptor, WalkerHost } from '../src/contracts/Contract.ts';
import type { WasmTransport } from '../src/plugins/wasm/WasmTransport.ts';
import { InProcessMockTransport } from '../src/plugins/wasm/transports/InProcessMockTransport.ts';
import { JspiTransport } from '../src/plugins/wasm/transports/JspiTransport.ts';
import { AtomicsWorkerTransport } from '../src/plugins/wasm/transports/AtomicsWorkerTransport.ts';

// -- Fixtures ------------------------------------------------------

async function loadFixture(name: string): Promise<WebAssembly.Module> {
  const url = new URL(`./fixtures/wasm/${name}.wasm`, import.meta.url);
  const bytes = await Deno.readFile(url);
  return await WebAssembly.compile(bytes);
}

import type { CompiledStack } from '../src/plugins/wasm/WasmLayers.ts';

/** Wrap a single module as a single-layer CompiledStack (it IS the top). */
function singleStack(module: WebAssembly.Module): CompiledStack {
  return { layers: [{ module }] };
}

// -- Mock env / hosts ---------------------------------------------

/** Recording env: synchronous; captures emitOutput calls verbatim. */
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

  emitOutput(verifier: Verifier, value: number, body?: Uint8Array): void {
    this.emittedOutputs.push({ verifier, value, body });
  }

  requestBody(): { value: number; body: Uint8Array } {
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

  fork(): void {
    throw new ContractRejection('fork not supported in tests');
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

class FixedBuilder implements BuilderHost {
  constructor(private readonly answers: Record<string, string>) {}
  requestBytes(_key: string, _desc: ValueDescriptor): Uint8Array {
    return new Uint8Array(0);
  }
  requestString(key: string, _desc: ValueDescriptor): string {
    return this.answers[key] ?? '';
  }
  requestNumber(): number {
    return 0;
  }
  requestBool(): boolean {
    return false;
  }
  requestArrayLength(): number {
    return 0;
  }
  beginObject(): void {}
  endObject(): void {}
  beginArray(): void {}
  endArray(): void {}
  validationError(): void {}
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
        const module = await loadFixture('echo');
        const env = new RecordingEnv(new TextEncoder().encode('hello world'));
        await transport.run(singleStack(module), env);
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
        const module = await loadFixture('reject_test');
        const env = new RecordingEnv(new Uint8Array(0));
        await assertRejects(
          () => transport.run(singleStack(module), env),
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
        const module = await loadFixture('walker_test');
        const walker = new RecordingWalker();
        await transport.walkParams(singleStack(module), new Uint8Array(0), walker);
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
        const module = await loadFixture('builder_test');
        const builder = new FixedBuilder({ name: 'Joel' });
        const result = await transport.buildParams(singleStack(module), builder);
        assertEquals(new TextDecoder().decode(result), 'Joel');
      } finally {
        await transport.close();
      }
    },
  });
}
