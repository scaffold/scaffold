// CONTRACT_CONTRACT: validator for contract blocks. A contract block
// describes a contract that other contract blocks may reference -- its
// WASM module set, its WASI setup, and the output namespaces it owns.
// See docs/protocol/wasm-abi.md#block-level-contract-metadata for the
// shape of those records.
//
// This simply does some basic checking on contract blocks; the contract
// could still be malformed or un-executable for some reason.

import { RECORD_CONTRACT } from '../core/Block.ts';
import type { Contract } from './Contract.ts';
import { str2bin } from '../util/buffer.ts';

// NOTE: Phase 1 keeps this on the deprecated record/request surface. The
// single-blob answer migration (getResult + JSON.parse of the contract spec)
// is deferred to phase 2 because the per-record metadata is read by the WASM
// loader (WasmContractPlugin.readOutputNamespaces). See docs/protocol/results.md
// and TODO.md "Result model migration".
export const contractContract: Contract = {
  outputNamespaces: [RECORD_CONTRACT],

  async run(env) {
    // const answer = await env.claimNext();
    // const { modules, wasiSetup, outputNamespaces } = JSON.parse(bin2str(answer.body));

    await env.request({ contract: RECORD_CONTRACT, params: str2bin('modules') });
    await env.request({ contract: RECORD_CONTRACT, params: str2bin('wasi_setup') });
    await env.request({ contract: RECORD_CONTRACT, params: str2bin('output_namespaces') });

    // TODO: Verify records parse as json
    // TODO: Verify that WASM blobs are deterministic (see scripts/wasm-determinism/)
  },
};
