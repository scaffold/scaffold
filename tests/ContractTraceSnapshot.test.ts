// Sanity tests for tests/helpers/contractSnapshot.ts.
//
// First-time snapshot generation: deno test --allow-all tests/ContractTraceSnapshot.test.ts -- --update
// Subsequent runs verify the trace text matches the committed .snap file.

import { assertRejects } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { ExecutionMode } from '../src/core/ContractEnv.ts';
import { assertContractTraceSnapshot } from './helpers/contractSnapshot.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

async function loadFixtureBytes(name: string): Promise<Uint8Array> {
  const url = new URL(`./fixtures/wasm/${name}.wasm`, import.meta.url);
  return await Deno.readFile(url);
}

Deno.test(
  'ContractTraceSnapshot: echo contract round-trips with one emit_output',
  async (t) => {
    const echoBytes = await loadFixtureBytes('echo');
    const echoHash = Hash.digest(echoBytes);
    const modulesSpec = {
      base: {
        version: 20250510,
        imports: { run: 'main:run' },
        memories: { heap: { initial: 16, maximum: 4096, shared: true } },
      },
      layers: [
        {
          key: 'main',
          wasmHash: echoHash.toHex(),
          imports: { 'scaffold_env.*': 'base:*', 'env.memory': 'base:heap' },
        },
      ],
    };

    await assertContractTraceSnapshot(t, {
      records: { modules: modulesSpec },
      blobs: { [echoHash.toHex()]: echoBytes },
      mock: {
        mode: ExecutionMode.Verification,
        params: utf8('hello world'),
      },
      sequence: [
        {
          type: 'emit_output',
          expect: {
            verifier: { contract: ZERO_HASH, params: utf8('echo') },
            value: 0,
            body: utf8('hello world'),
          },
        },
      ],
    });
  },
);

Deno.test(
  'ContractTraceSnapshot: sequence type mismatch produces clear error',
  async () => {
    const echoBytes = await loadFixtureBytes('echo');
    const echoHash = Hash.digest(echoBytes);
    const modulesSpec = {
      base: {
        version: 20250510,
        imports: { run: 'main:run' },
        memories: { heap: { initial: 16, maximum: 4096, shared: true } },
      },
      layers: [
        {
          key: 'main',
          wasmHash: echoHash.toHex(),
          imports: { 'scaffold_env.*': 'base:*', 'env.memory': 'base:heap' },
        },
      ],
    };

    await assertRejects(
      async () => {
        // Mock-less for `params` and `emit_output` -- both will fall through
        // to the sequence. Sequence is wrong type for both.
        const t = { step: () => {} } as unknown as Deno.TestContext;
        await assertContractTraceSnapshot(t, {
          records: { modules: modulesSpec },
          blobs: { [echoHash.toHex()]: echoBytes },
          mock: {
            mode: ExecutionMode.Verification,
            params: utf8('hello world'),
          },
          sequence: [
            // Contract will call `emit_output`, not `request_body`.
            {
              type: 'request_body',
              expect: { verifier: { contract: ZERO_HASH } },
              respond: { value: 0, body: new Uint8Array(0) },
            },
          ],
        });
      },
      Error,
      'expected "request_body" but contract called "emit_output"',
    );
  },
);

Deno.test(
  'ContractTraceSnapshot: sequence under-consumed produces clear error',
  async () => {
    const echoBytes = await loadFixtureBytes('echo');
    const echoHash = Hash.digest(echoBytes);
    const modulesSpec = {
      base: {
        version: 20250510,
        imports: { run: 'main:run' },
        memories: { heap: { initial: 16, maximum: 4096, shared: true } },
      },
      layers: [
        {
          key: 'main',
          wasmHash: echoHash.toHex(),
          imports: { 'scaffold_env.*': 'base:*', 'env.memory': 'base:heap' },
        },
      ],
    };

    await assertRejects(
      async () => {
        const t = { step: () => {} } as unknown as Deno.TestContext;
        await assertContractTraceSnapshot(t, {
          records: { modules: modulesSpec },
          blobs: { [echoHash.toHex()]: echoBytes },
          mock: {
            mode: ExecutionMode.Verification,
            params: utf8('hello world'),
          },
          sequence: [
            { type: 'emit_output' }, // contract will consume this
            { type: 'emit_output' }, // ...but never call emit_output again
            { type: 'sign' }, // ...nor sign
          ],
        });
      },
      Error,
      'sequence under-consumed',
    );
  },
);
