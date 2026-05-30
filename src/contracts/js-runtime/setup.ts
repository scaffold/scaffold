// Protocol spec: docs/design/wasi-shim.md
//
// Package a contract author's JavaScript source into the records + blobs of a
// runnable Scaffold contract block. The contract runs the author's `run()`
// through QuickJS (stacked on the wasi-shim), with the `scaffold` global from
// `prelude.ts` providing params/result.
//
// This is the JS-specific layer above `wasi-shim/setup.ts#buildContractRecords`:
// it fixes `argv = ['qjs', '--std', '-e', <prelude + source + dispatch>]` and
// otherwise reuses the same modules/wasi_setup/output_namespaces shape.

import { Hash } from '../../util/Hash.ts';
import {
  buildContractRecords,
  buildContractRecordsFromHashes,
  type ShimContractInputs,
} from '../wasi-shim/setup.ts';
import { wrapJsProgram } from './prelude.ts';

/**
 * Build the contract records + blobs for a single-file JavaScript contract.
 *
 * @param opts.shimBytes the wasi-shim.wasm blob.
 * @param opts.quickjsBytes the QuickJS (qjs-wasi) wasm blob.
 * @param opts.source the author's JavaScript source. Must define `run()`.
 * @param opts.outputNamespaces (contract, params) pairs the program may emit
 *   into. Defaults to `[]`; the `scaffold.result()` RECORD/'default' output is
 *   a self-claim and does not need a declared namespace.
 */
export function buildJsContractRecords(opts: {
  shimBytes: Uint8Array;
  quickjsBytes: Uint8Array;
  source: string;
  outputNamespaces?: ReadonlyArray<{ contract: Hash; params: Uint8Array }>;
}): ShimContractInputs {
  const program = wrapJsProgram(opts.source);
  return buildContractRecords({
    shimBytes: opts.shimBytes,
    programBytes: opts.quickjsBytes,
    setup: { argv: ['qjs', '--std', '-e', program] },
    outputNamespaces: opts.outputNamespaces,
  });
}

/**
 * Build just the records (no blobs) for a single-file JavaScript contract,
 * given the wasi-shim and QuickJS blob *hashes*. Use this when those blobs are
 * already available to verifiers (the well-known blocks), so they need not be
 * re-published -- e.g. inside the JS compiler contract. `modules` is returned
 * as a JS object (its on-chain form is JSON).
 */
export function buildJsContractRecordsFromHashes(opts: {
  shimHash: Hash;
  quickjsHash: Hash;
  /** Optional generic JSON walker/builder layer (json-wb) for params/data. */
  jsonWbHash?: Hash;
  source: string;
  outputNamespaces?: ReadonlyArray<{ contract: Hash; params: Uint8Array }>;
}): ShimContractInputs['records'] {
  const program = wrapJsProgram(opts.source);
  return buildContractRecordsFromHashes({
    shimHash: opts.shimHash,
    programHash: opts.quickjsHash,
    jsonWbHash: opts.jsonWbHash,
    setup: { argv: ['qjs', '--std', '-e', program] },
    outputNamespaces: opts.outputNamespaces,
  });
}
