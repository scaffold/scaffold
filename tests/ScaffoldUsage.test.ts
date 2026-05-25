// End-to-end usage examples for the `Scaffold` class. Each test demonstrates
// one publishing pattern and asserts the resulting block's shape. These
// double as runnable documentation for new contributors: copy a test body,
// drop it into a script, and you have a working integration.
//
// Patterns covered:
//   1. `scaffold.put(HASH_CONTRACT, ...)` -- publish a content-addressed blob.
//   2. `scaffold.put(CONTRACT_CONTRACT, ...)` -- publish a contract block.
//   3. `scaffold.put(<contractBlock.hash>, ...)` -- invoke a contract block
//      end-to-end (publishes WASM blobs, the contract block, then executes
//      a JavaScript program through the WASI shim + QuickJS).
//
// Prerequisites for example 3:
//   - `cd src/contracts/wasi-shim && zig build`  (produces wasi-shim.wasm)
//   - `deno task vendor:quickjs`                 (fetches qjs-wasi.wasm)
// Missing artifacts cause the JS-execution test to skip cleanly.

import { assert, assertEquals } from '@std/assert';
import { Scaffold } from '../src/Scaffold.ts';
import { CONTRACT_CONTRACT, HASH_CONTRACT, RECORD_CONTRACT } from '../src/core/Block.ts';
import { DEFAULT_KEY, hashContract } from '../src/contracts/HashContract.ts';
import { contractContract } from '../src/contracts/ContractContract.ts';
import { findRecordOutput } from '../src/contracts/RecordContract.ts';
import { Hash } from '../src/util/Hash.ts';
import { buildContractRecords } from '../src/contracts/wasi-shim/setup.ts';
import { loadWasiShim } from './helpers/loadWasiShim.ts';
import { loadQuickJs } from './helpers/loadQuickJs.ts';
import { wasmContractPlugin } from '../src/plugins/wasm/WasmContractPlugin.ts';
import { bin2str, str2bin } from '../src/util/buffer.ts';

Deno.test('Scaffold.put: publish a content-addressed blob via HASH_CONTRACT', async () => {
  const scaffold = new Scaffold({ enableLogging: false });
  try {
    scaffold.registerContract(HASH_CONTRACT, hashContract);

    // The blob bytes -- empty here just to keep the example minimal.
    const blob = new Uint8Array(0);

    // `put` runs hashContract's generator with the supplied records. The
    // generator calls `env.request({contract: RECORD_CONTRACT, params: 'default'})`,
    // which (in generation mode) adds a RECORD/default output to the draft and
    // returns the body from `records.default`.
    const block = await scaffold.put({
      contract: HASH_CONTRACT,
      params: Hash.digest(blob).toBytes(),
      records: { [DEFAULT_KEY]: blob },
    });

    // The block carries the RECORD/'default' output the generator requested.
    const record = findRecordOutput(block, DEFAULT_KEY);
    assert(record, 'expected a RECORD/default output on the publish block');
    assertEquals(record.body, blob);
  } finally {
    await scaffold.close();
  }
});

Deno.test('Scaffold.put: publish a contract block via CONTRACT_CONTRACT', async () => {
  const scaffold = new Scaffold({ enableLogging: false });
  try {
    scaffold.registerContract(CONTRACT_CONTRACT, contractContract);

    // contractContract.run requests three records: modules, wasi_setup,
    // output_namespaces. Each request adds a RECORD/<key> output to the
    // draft and resolves to the body we supply here.
    const modules = str2bin(JSON.stringify({
      base: { version: 20250510, imports: { run: 'main:run' } },
      layers: [{ key: 'main', wasmHash: '0'.repeat(64), imports: { 'env.*': 'host:*' } }],
    }));
    const wasiSetup = str2bin(JSON.stringify({ argv: ['program'], env: {} }));
    const outputNamespaces = new Uint8Array(0);

    const block = await scaffold.put({
      contract: CONTRACT_CONTRACT,
      params: new Uint8Array(0),
      records: {
        modules,
        wasi_setup: wasiSetup,
        output_namespaces: outputNamespaces,
      },
    });

    // All three records land on the block as RECORD/<key> outputs.
    assertEquals(findRecordOutput(block, 'modules')?.body, modules);
    assertEquals(findRecordOutput(block, 'wasi_setup')?.body, wasiSetup);
    assertEquals(findRecordOutput(block, 'output_namespaces')?.body, outputNamespaces);
  } finally {
    await scaffold.close();
  }
});

Deno.test(
  'Scaffold.put: run a JavaScript program end-to-end through WASI shim + QuickJS',
  async (t) => {
    // Load the WASM artifacts. Skip cleanly if either prerequisite is missing
    // (matches WasiShimQuickJS.test.ts's pattern -- ignored steps surface in
    // test output so the skip is noticed).
    let shimBytes: Uint8Array;
    let qjsBytes: Uint8Array;
    try {
      shimBytes = await loadWasiShim();
      qjsBytes = await loadQuickJs();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await t.step({ name: `skipped: ${msg}`, ignore: true, fn: () => {} });
      return;
    }

    // The default `resolveBlob` goes through FetchManager (incentive-based
    // peer fetch). For a single-node test there are no peers to respond, so
    // hand the plugin a closure that walks the local store directly: a
    // HASH_CONTRACT publish carries a RECORD/'default' output whose body,
    // when hashed, equals the requested hash.
    const holder: { scaffold?: Scaffold } = {};
    const localPlugin = wasmContractPlugin({
      resolveBlob: (hash) => {
        const sf = holder.scaffold;
        if (!sf) throw new Error('Scaffold not yet wired');
        for (const block of sf.context.store.values()) {
          const record = findRecordOutput(block, DEFAULT_KEY);
          if (!record) continue;
          if (Hash.equals(Hash.digest(record.body), hash)) {
            return Promise.resolve(record.body);
          }
        }
        return Promise.reject(new Error(`blob not in local store: ${hash.toHex()}`));
      },
    });

    const scaffold = new Scaffold({ contractPlugins: [localPlugin], enableLogging: false });
    holder.scaffold = scaffold;
    try {
      scaffold.registerContract(HASH_CONTRACT, hashContract);
      scaffold.registerContract(CONTRACT_CONTRACT, contractContract);

      // `wasi_setup.argv = ['qjs', '-e', PROGRAM]` runs an inline JS one-liner.
      // QuickJS's `print(...)` writes via fd_write to stdout; routing stdout to
      // /out/record/default makes that text land on the execution block as a
      // RECORD/default output (the wasi-shim translates /out/record/<key>
      // writes into RECORD_CONTRACT outputs).
      const PROGRAM = "print('hello from scaffold via quickjs');";
      // QuickJS's `print` adds a trailing newline.
      const EXPECTED_OUTPUT = 'hello from scaffold via quickjs\n';

      const inputs = buildContractRecords({
        shimBytes,
        programBytes: qjsBytes,
        setup: { argv: ['qjs', '-e', PROGRAM], stdout: '/out/record/default' },
      });

      // 1) Publish each WASM blob as a HASH_CONTRACT block so the contract
      //    plugin's `resolveBlob` can find them.
      for (const [hex, bytes] of Object.entries(inputs.blobs)) {
        await scaffold.put({
          contract: HASH_CONTRACT,
          params: Hash.fromHex(hex).toBytes(),
          records: { [DEFAULT_KEY]: bytes },
        });
      }

      // 2) Publish the contract block. buildContractRecords returns `modules`
      //    as a JS object (the on-chain form is JSON); normalise to bytes.
      //    `output_namespaces` is overridden to empty bytes -- the program
      //    writes only to /out/record/default, so WasmContractPlugin's
      //    namespace check (concatenated 32-byte hashes) needs the empty form.
      const normalise = (v: unknown): Uint8Array =>
        v instanceof Uint8Array ? v : str2bin(JSON.stringify(v));
      const contractRecords: Record<string, Uint8Array> = {};
      for (const [key, value] of Object.entries(inputs.records)) {
        contractRecords[key] = normalise(value);
      }
      contractRecords.output_namespaces = new Uint8Array(0);

      const contractBlock = await scaffold.put({
        contract: CONTRACT_CONTRACT,
        params: new Uint8Array(0),
        records: contractRecords,
      });

      // 3) Invoke the contract by putting under its block hash. The contract
      //    host loads the contract block; wasmContractPlugin recognises the
      //    `modules` record and builds an executor that runs through the
      //    shim. `records: {}` because the program reads its setup via
      //    env.contractMetadata, not env.request.
      const execBlock = await scaffold.put({
        contract: contractBlock.hash,
        params: new Uint8Array(0),
        records: {},
      });

      // The program's print(...) output appears as a RECORD/default output
      // on the execution block.
      const record = findRecordOutput(execBlock, DEFAULT_KEY);
      assert(
        record,
        `expected a RECORD/default output on the execution block; got outputs: ${
          execBlock.outputs.map((o) =>
            Hash.equals(o.verifier.contract, RECORD_CONTRACT)
              ? `RECORD/${bin2str(o.verifier.params)}`
              : o.verifier.contract.toHex().slice(0, 10)
          ).join(', ')
        }`,
      );
      assertEquals(bin2str(record.body), EXPECTED_OUTPUT);
    } finally {
      await scaffold.close();
    }
  },
);
