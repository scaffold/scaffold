// The headline flow: compile JavaScript source into a contract, then invoke it.
// The JS compiler is not a built-in -- the host seeds the well-known blob
// blocks and registers the compiler (see `registerJsCompiler`); blobs then
// resolve from the local store.
//
// Prerequisites: deno task build:wasi-shim, vendor:quickjs, build:well-known.
// Missing artifacts skip the test cleanly.

import { assert, assertEquals } from '@std/assert';
import { Scaffold } from '../src/Scaffold.ts';
import { Hash } from '../src/util/Hash.ts';
import { DEFAULT_KEY } from '../src/contracts/HashContract.ts';
import { JS_COMPILER_CONTRACT } from '../src/contracts/JsCompilerContract.ts';
import { findRecordOutput } from '../src/contracts/RecordContract.ts';
import { getWellKnownBlocks } from '../src/wellKnown.ts';
import { registerJsCompiler } from './helpers/jsCompiler.ts';
import { loadWasiShim } from './helpers/loadWasiShim.ts';
import { loadQuickJs } from './helpers/loadQuickJs.ts';
import { bin2str } from '../src/util/buffer.ts';

Deno.test('JS compiler contract + invoke: hello-world JS contract', async (t) => {
  try {
    await loadWasiShim();
    await loadQuickJs();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await t.step({ name: `skipped: ${msg}`, ignore: true, fn: () => {} });
    return;
  }
  if (getWellKnownBlocks().length === 0) {
    await t.step({
      name: 'skipped: well-known blocks not built (deno task build:well-known)',
      ignore: true,
      fn: () => {},
    });
    return;
  }

  const scaffold = new Scaffold({
    enableLogging: false,
    wellKnownBlocks: getWellKnownBlocks(),
  });
  registerJsCompiler(scaffold);
  try {
    const source = `
      function run() {
        const { name } = JSON.parse(scaffold.params());
        scaffold.result(JSON.stringify({ message: 'hello ' + name }));
      }
    `;

    // 1. Invoke the JS compiler contract by its well-known hash, like any
    //    other contract -- no bespoke compile() method. Its RECORD/'default'
    //    result is the new contract block's hash.
    const compileBlock = await scaffold.put({
      contract: JS_COMPILER_CONTRACT,
      params: { files: { '/main.js': source } },
      records: {},
    });
    const compileResult = findRecordOutput(compileBlock, DEFAULT_KEY);
    assert(compileResult, 'compiler produced a result record');
    const contractHash = Hash.fromBytes(compileResult.body);

    // 2. Invoke the compiled contract with a plain object as params -- it is
    //    canonical-JSON encoded, which is what the contract's
    //    JSON.parse(scaffold.params()) expects.
    const execBlock = await scaffold.put({
      contract: contractHash,
      params: { name: 'World' },
      records: {},
    });

    const result = findRecordOutput(execBlock, DEFAULT_KEY);
    assertEquals(result && bin2str(result.body), JSON.stringify({ message: 'hello World' }));

    // 3. The compiled contract carries the generic json-wb codec layer, so its
    //    walkData (the json-wb walker) decodes the result bytes into an object
    //    -- exercised here directly to prove the declared codec is live, not
    //    just the host-side JSON fast path.
    const impl = scaffold.context.contractHost.getContract(contractHash);
    assert(impl?.walkData, 'compiled contract should expose walkData (json-wb layer)');
    const { RecordingWalkerHost } = await import('../src/core/RecordingWalkerHost.ts');
    const walker = new RecordingWalkerHost();
    await impl.walkData!(result!.body, walker);
    const tree = walker.getTree();
    // Top-level object emitted under the empty key.
    assertEquals(tree.length, 1);
    assertEquals(tree[0].kind, 'map');
  } finally {
    await scaffold.close();
  }
});
