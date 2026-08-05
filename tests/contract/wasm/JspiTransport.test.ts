import { assertEquals, assertRejects } from '@std/assert';
import { ContractRejection } from '../../../src/contract/ContractRejection.ts';
import { JspiTransport } from '../../../src/contract/wasm/JspiTransport.ts';
import { hostFn } from '../../../src/contract/wasm/WasmTransport.ts';
import { str2bin } from '../../../src/util/buffer.ts';
import { CancelError } from '../../../src/util/RunQueue.ts';

const ignore = !JspiTransport.isSupported();

const fixture = async (name: string) =>
  await WebAssembly.compile(
    await Deno.readFile(new URL(`../../fixtures/wasm-v2/${name}`, import.meta.url)),
  );

Deno.test({
  name: 'jspi runs echo with only sync imports',
  ignore,
  fn: async () => {
    const results: Uint8Array[] = [];
    await new JspiTransport().invoke(await fixture('echo.wasm'), 'run', {
      scaffold_env: {
        params: hostFn([], 'bytes', false, () => str2bin('hello')),
        set_result: hostFn(['bytes'], 'void', false, (data) => void results.push(data)),
      },
    });
    assertEquals(results, [str2bin('hello')]);
  },
});

Deno.test({
  name: 'jspi suspends the guest across a genuinely async claim',
  ignore,
  fn: async () => {
    const results: Uint8Array[] = [];
    await new JspiTransport().invoke(await fixture('claim_echo.wasm'), 'run', {
      scaffold_env: {
        claim: hostFn([], 'bytes', true, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return str2bin('claimed!');
        }),
        set_result: hostFn(['bytes'], 'void', false, (data) => void results.push(data)),
      },
    });
    assertEquals(results, [str2bin('claimed!')]);
  },
});

Deno.test({
  name: 'jspi reject surfaces as ContractRejection',
  ignore,
  fn: async () => {
    const module = await fixture('reject.wasm');
    await assertRejects(
      () =>
        new JspiTransport().invoke(module, 'run', {
          scaffold_env: {
            reject: hostFn(['str'], 'void', false, (reason) => {
              throw new ContractRejection(reason);
            }),
          },
        }),
      ContractRejection,
      'nope',
    );
  },
});

Deno.test({
  name: 'jspi refuses to resume after an abort during a blocking import',
  ignore,
  fn: async () => {
    const module = await fixture('claim_echo.wasm');
    const controller = new AbortController();
    await assertRejects(
      () =>
        new JspiTransport().invoke(module, 'run', {
          scaffold_env: {
            claim: hostFn([], 'bytes', true, () => {
              controller.abort();
              return Promise.resolve(str2bin('too late'));
            }),
            set_result: hostFn(['bytes'], 'void', false, () => {}),
          },
        }, { signal: controller.signal }),
      CancelError,
    );
  },
});
