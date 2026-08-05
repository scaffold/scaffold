import { assertEquals, assertInstanceOf, assertRejects } from '@std/assert';
import { ContractRejection } from '../../../src/contract/ContractRejection.ts';
import { InProcessTransport } from '../../../src/contract/wasm/InProcessTransport.ts';
import { hostFn } from '../../../src/contract/wasm/WasmTransport.ts';
import { str2bin } from '../../../src/util/buffer.ts';
import { CancelError } from '../../../src/util/RunQueue.ts';

const fixture = async (name: string) =>
  await WebAssembly.compile(
    await Deno.readFile(new URL(`../../fixtures/wasm-v2/${name}`, import.meta.url)),
  );

Deno.test('invoke runs echo, delivering params to set_result', async () => {
  const results: Uint8Array[] = [];
  await new InProcessTransport().invoke(await fixture('echo.wasm'), 'run', {
    scaffold_env: {
      params: hostFn([], 'bytes', false, () => str2bin('hello')),
      set_result: hostFn(['bytes'], 'void', false, (data) => void results.push(data)),
    },
  });
  assertEquals(results, [str2bin('hello')]);
});

Deno.test('a guest reject surfaces as ContractRejection', async () => {
  const module = await fixture('reject.wasm');
  await assertRejects(
    () =>
      new InProcessTransport().invoke(module, 'run', {
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

Deno.test('a guest trap surfaces as a crash, not a rejection', async () => {
  const module = await fixture('trap.wasm');
  const err = await assertRejects(() => new InProcessTransport().invoke(module, 'run', {}));
  assertInstanceOf(err, Error);
  assertEquals(err instanceof ContractRejection, false);
});

Deno.test('a blocking import that returns a promise is a hard error', async () => {
  const module = await fixture('claim_echo.wasm');
  await assertRejects(
    () =>
      new InProcessTransport().invoke(module, 'run', {
        scaffold_env: {
          claim: hostFn([], 'bytes', true, () => Promise.resolve(new Uint8Array())),
          set_result: hostFn(['bytes'], 'void', false, () => {}),
        },
      }),
    Error,
    'cannot suspend on scaffold_env.claim',
  );
});

Deno.test('a declared import missing from the active tables traps at call time', async () => {
  const module = await fixture('echo.wasm');
  await assertRejects(
    () =>
      new InProcessTransport().invoke(module, 'run', {
        scaffold_env: {
          set_result: hostFn(['bytes'], 'void', false, () => {}),
        },
      }),
    Error,
    'scaffold_env.params is not available',
  );
});

Deno.test('invoke on an already-aborted signal throws CancelError', async () => {
  const module = await fixture('echo.wasm');
  const controller = new AbortController();
  controller.abort();
  await assertRejects(
    () => new InProcessTransport().invoke(module, 'run', {}, { signal: controller.signal }),
    CancelError,
  );
});

Deno.test('a missing entry export is an error naming it', async () => {
  const module = await fixture('trap.wasm');
  await assertRejects(
    () => new InProcessTransport().invoke(module, 'missing', {}),
    Error,
    'does not export "missing"',
  );
});
