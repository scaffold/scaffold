import { assertEquals } from '@std/assert';
import { createSource } from '../../../src/contract/createSource.ts';
import { encodeManifest } from '../../../src/contract/wasm/WasmManifest.ts';
import { Fetch } from '../../../src/peer/Fetch.ts';
import { GeneratorRole } from '../../../src/roles/GeneratorRole.ts';
import { str2bin } from '../../../src/util/buffer.ts';
import { makePublishHarness } from '../../helpers/blocks.ts';
import { makeTestContext } from '../../helpers/v2.ts';

const until = async (cb: () => boolean, timeoutMs = 5000) => {
  const start = Date.now();
  while (!cb()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

Deno.test('a wasm contract result is fetched end-to-end through generation', async () => {
  const ctx = makeTestContext();
  const h = makePublishHarness(ctx);

  const moduleBytes = await Deno.readFile(
    new URL('../../fixtures/wasm-v2/echo.wasm', import.meta.url),
  );
  const moduleHash = h.publishBlob(moduleBytes);
  const contractHash = h.publishBlob(
    encodeManifest({ version: 1, module: moduleHash, entries: { run: 'run' } }),
  );

  ctx.get(GeneratorRole);

  const results: Uint8Array[] = [];
  await ctx.get(Fetch).fetch({
    contract: contractHash,
    params: str2bin('hello wasm'),
    onResult: (result) => {
      if (result !== null) results.push(result.body);
    },
  });

  await until(() => results.length > 0);
  assertEquals(results[0], str2bin('hello wasm'));
  await ctx.destruct();
});

Deno.test('a wasm contract serves structured params and parseable results end-to-end', async () => {
  const ctx = makeTestContext();
  const h = makePublishHarness(ctx);

  const moduleBytes = await Deno.readFile(
    new URL('../../fixtures/wasm-v2/hello.wasm', import.meta.url),
  );
  const moduleHash = h.publishBlob(moduleBytes);
  const contractHash = h.publishBlob(encodeManifest({
    version: 1,
    module: moduleHash,
    entries: {
      run: 'run',
      walk_params: 'walk_params',
      walk_data: 'walk_data',
      build_params: 'build_params',
    },
  }));

  ctx.get(GeneratorRole);

  const parsed: Promise<unknown>[] = [];
  await ctx.get(Fetch).fetch({
    contract: contractHash,
    params: () => createSource({ name: 'world' }),
    onResult: (result) => {
      if (result !== null) parsed.push(result.parse());
    },
  });

  await until(() => parsed.length > 0);
  assertEquals(await parsed[0], { message: 'Hello, world' });
  await ctx.destruct();
});
