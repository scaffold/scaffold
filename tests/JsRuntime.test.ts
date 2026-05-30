// End-to-end test for the JS runtime: a contract author writes plain JS against
// the `scaffold` global, and it runs through QuickJS + the wasi-shim. This is
// the zero-config path -- the default `Scaffold` seeds the well-known blob
// blocks (wasi-shim + QuickJS) and resolves blobs from the local store, so
// there is no manual blob publishing and no custom `resolveBlob`.
//
// Prerequisites (same as ScaffoldUsage.test.ts #3):
//   - `deno task build:wasi-shim`
//   - `deno task vendor:quickjs`
//   - `deno task build:well-known`  (seeds the blob blocks)
// Missing artifacts skip the test cleanly.

import { assertEquals } from '@std/assert';
import { Scaffold } from '../src/Scaffold.ts';
import { CONTRACT_CONTRACT } from '../src/core/Block.ts';
import { DEFAULT_KEY } from '../src/contracts/HashContract.ts';
import { findRecordOutput } from '../src/contracts/RecordContract.ts';
import { buildJsContractRecords } from '../src/contracts/js-runtime/setup.ts';
import { getWellKnownBlocks } from '../src/wellKnown.ts';
import { loadWasiShim } from './helpers/loadWasiShim.ts';
import { loadQuickJs } from './helpers/loadQuickJs.ts';
import { bin2str, str2bin } from '../src/util/buffer.ts';

Deno.test('js-runtime: scaffold.params/result round-trip (zero-config seeding)', async (t) => {
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
  if (getWellKnownBlocks().length === 0) {
    await t.step({
      name: 'skipped: well-known blocks not built (deno task build:well-known)',
      ignore: true,
      fn: () => {},
    });
    return;
  }

  // Default config: seeds well-known blob blocks, installs the default WASM
  // plugin whose resolveBlob checks the local store first.
  const scaffold = new Scaffold({ enableLogging: false });
  try {
    // The contract author's source -- plain JS against the `scaffold` global.
    const source = `
      function run() {
        const { name } = JSON.parse(scaffold.params());
        scaffold.result(JSON.stringify({ message: 'hello ' + name }));
      }
    `;

    const inputs = buildJsContractRecords({ shimBytes, quickjsBytes: qjsBytes, source });
    const records: Record<string, Uint8Array> = {};
    for (const [key, value] of Object.entries(inputs.records)) {
      records[key] = value instanceof Uint8Array ? value : str2bin(JSON.stringify(value));
    }

    const contractBlock = await scaffold.put({
      contract: CONTRACT_CONTRACT,
      params: new Uint8Array(0),
      records,
    });

    const execBlock = await scaffold.put({
      contract: contractBlock.hash,
      params: str2bin(JSON.stringify({ name: 'World' })),
      records: {},
    });

    const record = findRecordOutput(execBlock, DEFAULT_KEY);
    assertEquals(record && bin2str(record.body), JSON.stringify({ message: 'hello World' }));
  } finally {
    await scaffold.close();
  }
});
