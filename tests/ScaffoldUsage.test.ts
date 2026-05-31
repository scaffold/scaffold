// End-to-end usage examples for the `Scaffold` class. Each test demonstrates
// one pattern and asserts the resulting block's shape, doubling as runnable
// documentation: copy a test body into a script and you have a working
// integration.
//
// Patterns covered:
//   1. `put(HASH_CONTRACT, ...)`     -- publish a content-addressed blob.
//   2. `put(CONTRACT_CONTRACT, ...)` -- publish a contract block.
//   3. Compile + invoke a JavaScript contract, zero-config (the headline):
//      `put(JS_COMPILER_CONTRACT, {files})` -> contract hash, then
//      `put(contractHash, {params})` -> result. No `registerContract`, no
//      custom `resolveBlob`, no manual blob publishing -- the default Scaffold
//      auto-registers the built-in contracts (including the JS compiler), seeds
//      the well-known WASM blocks (wasi-shim, QuickJS, json-wb), and resolves
//      blobs from the local store.
//   4. (ignored) the intended `fetch`-based network invocation -- the shape we
//      are converging on, blocked today on generation-on-incentive.
//
// Examples 1 and 2 always run. Example 3 needs the well-known blocks built:
//   - `deno task build:well-known`  (builds the shim, vendors QuickJS, builds
//      json-wb, and bakes each into a HASH_CONTRACT block)
// Missing well-known blocks make example 3 skip cleanly.

import { assert, assertEquals } from '@std/assert';
import { Scaffold } from '../src/Scaffold.ts';
import { CONTRACT_CONTRACT, HASH_CONTRACT } from '../src/core/Block.ts';
import { DEFAULT_KEY } from '../src/contracts/HashContract.ts';
import { JS_COMPILER_CONTRACT } from '../src/contracts/JsCompilerContract.ts';
import { findRecordOutput } from '../src/contracts/RecordContract.ts';
import { getWellKnownBlocks } from '../src/wellKnown.ts';
import { Hash } from '../src/util/Hash.ts';
import { bin2str, str2bin } from '../src/util/buffer.ts';

Deno.test('Scaffold.put: publish a content-addressed blob via HASH_CONTRACT', async () => {
  const scaffold = new Scaffold({ enableLogging: false });
  try {
    const blob = str2bin('hello blob');

    // `put` runs HASH_CONTRACT's generator with the supplied records. The
    // generator requests `RECORD_CONTRACT/'default'`, which adds a
    // RECORD/default output carrying the blob and asserts its hash matches
    // the verifier params. HASH_CONTRACT is a built-in -- no registration.
    const block = await scaffold.put({
      contract: HASH_CONTRACT,
      params: Hash.digest(blob).toBytes(),
      records: { [DEFAULT_KEY]: blob },
    });

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
    // CONTRACT_CONTRACT (a built-in) requests three records: modules,
    // wasi_setup, output_namespaces. Each lands on the block as a
    // RECORD/<key> output. (These bytes are illustrative -- this example only
    // publishes the contract block, it does not execute it.)
    const modules = str2bin(JSON.stringify({
      base: { version: 20250510, imports: { run: 'main:run' } },
      layers: [{ key: 'main', wasmHash: '0'.repeat(64), imports: { 'env.*': 'host:*' } }],
    }));
    const wasiSetup = str2bin(JSON.stringify({ argv: ['program'], env: {} }));
    const outputNamespaces = new Uint8Array(0);

    const block = await scaffold.put({
      contract: CONTRACT_CONTRACT,
      params: new Uint8Array(0),
      records: { modules, wasi_setup: wasiSetup, output_namespaces: outputNamespaces },
    });

    assertEquals(findRecordOutput(block, 'modules')?.body, modules);
    assertEquals(findRecordOutput(block, 'wasi_setup')?.body, wasiSetup);
    assertEquals(findRecordOutput(block, 'output_namespaces')?.body, outputNamespaces);
  } finally {
    await scaffold.close();
  }
});

Deno.test('Scaffold: compile and invoke a JavaScript contract (zero-config)', async (t) => {
  // Skip cleanly on a fresh checkout where the well-known blocks (which carry
  // the wasi-shim / QuickJS / json-wb blobs) haven't been built yet.
  if (getWellKnownBlocks().length === 0) {
    await t.step({
      name: 'skipped: well-known blocks not built (deno task build:well-known)',
      ignore: true,
      fn: () => {},
    });
    return;
  }

  // Zero-config. The default Scaffold:
  //   - auto-registers the built-in contracts, including the JS compiler,
  //   - seeds the well-known WASM blocks (wasi-shim, QuickJS, json-wb),
  //   - resolves blobs from the local store (no peer fetch needed).
  const scaffold = new Scaffold({ enableLogging: false });
  try {
    // The contract author writes plain JS against the `scaffold` global:
    // `params()` reads the verifier params, `result()` publishes the result.
    const source = `
      function run() {
        const { name } = JSON.parse(scaffold.params());
        scaffold.result(JSON.stringify({ message: 'hello ' + name }));
      }
    `;

    // 1. Compile: invoke the JS compiler contract by its well-known hash. It
    //    packages the source into a contract block (stacking the shim, QuickJS,
    //    and the json-wb param/result codec) and records the new block's hash
    //    as its RECORD/'default' result.
    const compiled = await scaffold.put({
      contract: JS_COMPILER_CONTRACT,
      params: { files: { '/main.js': source } },
      records: {},
    });
    const compiledResult = findRecordOutput(compiled, DEFAULT_KEY);
    assert(compiledResult, 'compiler should produce a RECORD/default result');
    const contractHash = Hash.fromBytes(compiledResult.body);

    // 2. Invoke: `put` under the new contract's hash. Params are a plain object
    //    (canonical-JSON encoded); the result lands as a RECORD/'default'
    //    output, which `scaffold.result(...)` wrote.
    const exec = await scaffold.put({
      contract: contractHash,
      params: { name: 'World' },
      records: {},
    });
    const result = findRecordOutput(exec, DEFAULT_KEY);
    assert(result, 'expected a RECORD/default result on the execution block');
    assertEquals(bin2str(result.body), JSON.stringify({ message: 'hello World' }));
  } finally {
    await scaffold.close();
  }
});

// The shape we are converging on: invoke a contract *over the network* with a
// single `fetch`. A client publishes an incentive, peers compete to run the
// contract, and `verify: true` resolves the first canonical, locally-verified
// result -- no local compute or pre-seeded contract required:
//
//   const result = await scaffold.fetch({
//     contract: contractHash,
//     params: { name: 'World' },
//     verify: true,
//   });
//   JSON.parse(bin2str(result.body)); // { message: 'hello World' }
//
// Ignored because it is not yet wired end-to-end. `fetch` publishes the
// incentive block and the reactive layer reacts, but no default responder
// produces a block that *claims the incentive and records the keyed result* --
// the shape `FetchManager` waits on -- so the promise never resolves
// (generation-on-incentive / request routing; see TODO.md). Until that lands,
// use `put` (example 3) for local execution. The body type-checks so it stays
// valid as the migration target.
Deno.test({
  name: 'Scaffold.fetch: invoke a contract over the network (blocked: generation-on-incentive)',
  ignore: true,
  fn: async () => {
    const scaffold = new Scaffold({ enableLogging: false });
    try {
      const contractHash = Hash.fromHex('00'.repeat(32)); // some compiled contract
      const result = await scaffold.fetch({
        contract: contractHash,
        params: { name: 'World' },
        verify: true,
      });
      assertEquals(bin2str(result.body), JSON.stringify({ message: 'hello World' }));
    } finally {
      await scaffold.close();
    }
  },
});
