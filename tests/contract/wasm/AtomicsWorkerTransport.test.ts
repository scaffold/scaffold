import { assertEquals, assertRejects } from '@std/assert';
import { ContractRejection } from '../../../src/contract/ContractRejection.ts';
import { AtomicsWorkerTransport } from '../../../src/contract/wasm/AtomicsWorkerTransport.ts';
import { hostFn } from '../../../src/contract/wasm/WasmTransport.ts';
import { str2bin } from '../../../src/util/buffer.ts';
import { CancelError } from '../../../src/util/RunQueue.ts';

const fixture = async (name: string) =>
  await WebAssembly.compile(
    await Deno.readFile(new URL(`../../fixtures/wasm-v2/${name}`, import.meta.url)),
  );

const withTransport = async (
  fn: (transport: AtomicsWorkerTransport) => Promise<void>,
  opts?: { stagingBytes?: number },
) => {
  const transport = new AtomicsWorkerTransport(opts);
  try {
    await fn(transport);
  } finally {
    await transport.close();
  }
};

Deno.test('worker transport runs echo end to end', async () => {
  await withTransport(async (transport) => {
    const results: Uint8Array[] = [];
    await transport.invoke(await fixture('echo.wasm'), 'run', {
      scaffold_env: {
        params: hostFn([], 'bytes', false, () => str2bin('hello')),
        set_result: hostFn(['bytes'], 'void', false, (data) => void results.push(data)),
      },
    });
    assertEquals(results, [str2bin('hello')]);
  });
});

Deno.test('worker transport blocks the guest across an async claim', async () => {
  await withTransport(async (transport) => {
    const results: Uint8Array[] = [];
    await transport.invoke(await fixture('claim_echo.wasm'), 'run', {
      scaffold_env: {
        claim: hostFn([], 'bytes', true, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return str2bin('claimed!');
        }),
        set_result: hostFn(['bytes'], 'void', false, (data) => void results.push(data)),
      },
    });
    assertEquals(results, [str2bin('claimed!')]);
  });
});

Deno.test('worker reject surfaces as ContractRejection', async () => {
  await withTransport(async (transport) => {
    const module = await fixture('reject.wasm');
    await assertRejects(
      () =>
        transport.invoke(module, 'run', {
          scaffold_env: {
            reject: hostFn(['str'], 'void', false, (reason) => {
              throw new ContractRejection(reason);
            }),
          },
        }),
      ContractRejection,
      'nope',
    );
  });
});

Deno.test('worker trap surfaces as a crash', async () => {
  await withTransport(async (transport) => {
    const module = await fixture('trap.wasm');
    await assertRejects(() => transport.invoke(module, 'run', {}), Error, 'wasm crash');
  });
});

Deno.test('an abort mid-claim kills the worker with CancelError', async () => {
  await withTransport(async (transport) => {
    const module = await fixture('claim_echo.wasm');
    const controller = new AbortController();
    const pending = assertRejects(
      () =>
        transport.invoke(module, 'run', {
          scaffold_env: {
            claim: hostFn([], 'bytes', true, () => new Promise<Uint8Array>(() => {})),
            set_result: hostFn(['bytes'], 'void', false, () => {}),
          },
        }, { signal: controller.signal }),
      CancelError,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await pending;
  });
});

Deno.test('a reply that overflows the staging buffer crashes the guest', async () => {
  await withTransport(async (transport) => {
    const module = await fixture('echo.wasm');
    await assertRejects(
      () =>
        transport.invoke(module, 'run', {
          scaffold_env: {
            params: hostFn([], 'bytes', false, () => new Uint8Array(100)),
            set_result: hostFn(['bytes'], 'void', false, () => {}),
          },
        }),
      Error,
      'overflows the staging buffer',
    );
  }, { stagingBytes: 8 });
});
