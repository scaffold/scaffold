// The headline flow: compile JavaScript source into a contract, then invoke it.
// Zero-config -- the default Scaffold registers the JS compiler, seeds the
// well-known blob blocks, and resolves blobs locally.
//
// Prerequisites: deno task build:wasi-shim, vendor:quickjs, build:well-known.
// Missing artifacts skip the test cleanly.

import { assert, assertEquals } from '@std/assert';
import { Scaffold } from '../src/Scaffold.ts';
import { DEFAULT_KEY } from '../src/contracts/HashContract.ts';
import { findRecordOutput } from '../src/contracts/RecordContract.ts';
import { getWellKnownBlocks } from '../src/wellKnown.ts';
import { loadWasiShim } from './helpers/loadWasiShim.ts';
import { loadQuickJs } from './helpers/loadQuickJs.ts';
import { bin2str, str2bin } from '../src/util/buffer.ts';

Deno.test('Scaffold.compile + invoke: hello-world JS contract', async (t) => {
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

  const scaffold = new Scaffold({ enableLogging: false });
  try {
    const source = `
      function run() {
        const { name } = JSON.parse(scaffold.params());
        scaffold.result(JSON.stringify({ message: 'hello ' + name }));
      }
    `;

    // 1. Compile -> a contract block hash.
    const contractHash = await scaffold.compile({ files: { '/main.js': source } });
    assert(contractHash, 'compile returned a hash');

    // 2. Invoke the compiled contract.
    const execBlock = await scaffold.put({
      contract: contractHash,
      params: str2bin(JSON.stringify({ name: 'World' })),
      records: {},
    });

    const result = findRecordOutput(execBlock, DEFAULT_KEY);
    assertEquals(result && bin2str(result.body), JSON.stringify({ message: 'hello World' }));
  } finally {
    await scaffold.close();
  }
});
