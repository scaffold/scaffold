import { assertEquals, assertRejects } from '@std/assert';
import { ContractEnv, ExecutionMode } from '../../../src/contract/env/ContractEnv.ts';
import { ValueSink } from '../../../src/contract/values.ts';
import { WasmConfig } from '../../../src/contract/wasm/WasmConfig.ts';
import { WasmContract } from '../../../src/contract/wasm/WasmContract.ts';
import { encodeManifest, WasmManifest } from '../../../src/contract/wasm/WasmManifest.ts';
import { str2bin } from '../../../src/util/buffer.ts';
import { Hash } from '../../../src/util/Hash.ts';
import { neverAbort } from '../../../src/util/abortable.ts';
import { FlowCtl } from '../../../src/util/RunQueue.ts';
import { makeTestContext } from '../../helpers/v2.ts';

const flowCtl: FlowCtl = { signal: neverAbort, yield: () => {} };

const stubEnv = (): ContractEnv & { results: Uint8Array[] } => {
  const results: Uint8Array[] = [];
  return {
    results,
    mode: () => ExecutionMode.Generation,
    contractHash: () => Hash.digest('stub'),
    params: () => str2bin('params'),
    claim: () => str2bin('claimed'),
    getResult: () => str2bin('result'),
    setResult: (r) => void results.push(r),
  };
};

const dummySink: ValueSink = {
  setUnit: () => {},
  setBool: () => {},
  setNumber: () => {},
  setString: () => {},
  setBytes: () => {},
  setList: () => undefined,
  setStruct: () => undefined,
};

interface WasmHarness {
  contract: WasmContract;
  fetches(): number;
}

interface WasmHarnessOptions {
  entries?: WasmManifest['entries'];
  mutate?: (blobs: Map<string, Uint8Array>, contractHash: Hash) => Hash;
  failFirstFetch?: boolean;
}

async function wasmHarness(
  fixture: string,
  { entries = { run: 'run' }, mutate, failFirstFetch = false }: WasmHarnessOptions = {},
): Promise<WasmHarness> {
  const ctx = makeTestContext();
  const blobs = new Map<string, Uint8Array>();
  let fetches = 0;
  let failing = failFirstFetch;
  ctx.configure(WasmConfig, {
    // In-process keeps these tests worker-free; transports have their own suites.
    transport: 'inprocess',
    fetchBlob: (_ctx, hash, _signal) => {
      fetches++;
      if (failing) {
        failing = false;
        return Promise.reject(new Error('blob store offline'));
      }
      const blob = blobs.get(hash.toHex());
      return blob !== undefined
        ? Promise.resolve(blob)
        : Promise.reject(new Error(`no blob ${hash.toHex()}`));
    },
  });

  const moduleBytes = await Deno.readFile(
    new URL(`../../fixtures/wasm-v2/${fixture}`, import.meta.url),
  );
  const moduleHash = Hash.digest(moduleBytes);
  blobs.set(moduleHash.toHex(), moduleBytes);
  const manifestBytes = encodeManifest({ version: 1, module: moduleHash, entries });
  let contractHash = Hash.digest(manifestBytes);
  blobs.set(contractHash.toHex(), manifestBytes);
  if (mutate !== undefined) contractHash = mutate(blobs, contractHash);

  return { contract: new WasmContract(ctx, contractHash), fetches: () => fetches };
}

Deno.test('run executes the manifest run entry against the env', async () => {
  const { contract } = await wasmHarness('echo.wasm');
  const env = stubEnv();
  await contract.run(env, flowCtl);
  assertEquals(env.results, [str2bin('params')]);
});

Deno.test('manifest and module are fetched once across runs', async () => {
  const { contract, fetches } = await wasmHarness('echo.wasm');
  await contract.run(stubEnv(), flowCtl);
  await contract.run(stubEnv(), flowCtl);
  assertEquals(fetches(), 2);
});

Deno.test('a manifest entry the contract lacks is an error naming it', async () => {
  const { contract } = await wasmHarness('echo.wasm');
  await assertRejects(
    () => contract.walkParams(new Uint8Array(), () => dummySink),
    Error,
    'does not define walk_params',
  );
});

Deno.test('a manifest naming a missing export fails the load', async () => {
  const { contract } = await wasmHarness('echo.wasm', { entries: { run: 'launch' } });
  await assertRejects(() => contract.run(stubEnv(), flowCtl), Error, 'does not export "launch"');
});

Deno.test('a malformed manifest fails the load', async () => {
  const { contract } = await wasmHarness('echo.wasm', {
    mutate: (blobs) => {
      const garbage = str2bin('not a manifest');
      const hash = Hash.digest(garbage);
      blobs.set(hash.toHex(), garbage);
      return hash;
    },
  });
  await assertRejects(() => contract.run(stubEnv(), flowCtl), Error, 'not valid JSON');
});

Deno.test('a failed load is retried on the next call', async () => {
  const { contract } = await wasmHarness('echo.wasm', { failFirstFetch: true });
  await assertRejects(() => contract.run(stubEnv(), flowCtl), Error, 'blob store offline');
  const env = stubEnv();
  await contract.run(env, flowCtl);
  assertEquals(env.results, [str2bin('params')]);
});
