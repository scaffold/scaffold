#!/usr/bin/env -S deno run --allow-read
/**
 * Publish the wasm-determinism contract onto a fresh Scaffold node.
 *
 * Publishes three blocks via `scaffold.put`:
 *   1. The contract WASM blob (HASH_CONTRACT(hash) + RECORD_CONTRACT('default'))
 *   2. The transform-mode contract block (modules + output_namespaces +
 *      scaffold-determinism-mode = "transform")
 *   3. The verify-mode contract block (same modules + ...mode = "verify")
 *
 * Prints the resulting block / contract hashes as JSON on stdout.
 *
 * Usage:
 *   deno run --allow-read scripts/publish_determinism_contracts.ts
 */

import { Hash } from '../src/util/Hash.ts';
import { composeGenesisPacket, HASH_CONTRACT, RECORD_CONTRACT } from '../src/core/Block.ts';
import type { Output } from '../src/core/BlockCreationModule.ts';
import { makeRecordOutput } from '../src/contracts/RecordContract.ts';
import { Scaffold } from '../src/Scaffold.ts';
import { secp } from '../src/util/secp.ts';
import { makeSignatureOutput } from '../src/contracts/SignatureContract.ts';

const CONTRACT_WASM_PATH = new URL(
  './wasm-determinism/bin/wasm-determinism-contract.wasm',
  import.meta.url,
);

const TRANSFORM_VERSION = 20250510;

// ---- Block builders ----------------------------------------------------

function blobPublishBlock(blob: Uint8Array): Output[] {
  // The HASH_CONTRACT/(blob hash) output is the discovery beacon; the
  // RECORD_CONTRACT('default') output carries the bytes that the HASH_CONTRACT
  // verifier checks via request. Both must live on the same block.
  const blobHash = Hash.digest(blob);
  return [
    {
      verifier: { contract: HASH_CONTRACT, params: blobHash.toBytes() },
      value: 0,
      body: new Uint8Array(0),
    },
    makeRecordOutput('default', blob),
  ];
}

function modulesRecord(contractWasmHash: Hash): Output {
  const spec = {
    base: { version: TRANSFORM_VERSION, imports: { run: 'main:run' } },
    layers: {
      main: {
        wasmHash: contractWasmHash.toHex(),
        imports: { 'scaffold_env.*': 'base:*' },
      },
    },
  };
  return makeRecordOutput('modules', new TextEncoder().encode(JSON.stringify(spec)));
}

function contractBlockOutputs(
  contractWasmHash: Hash,
  mode: 'transform' | 'verify',
): Output[] {
  // Transform mode emits RECORD_CONTRACT outputs (default + outputWasmBytes).
  // Verify mode emits no outputs but must still declare the namespace (empty).
  const namespaceBytes = mode === 'transform' ? RECORD_CONTRACT.toBytes() : new Uint8Array(0);
  return [
    modulesRecord(contractWasmHash),
    makeRecordOutput('output_namespaces', namespaceBytes),
    makeRecordOutput('scaffold-determinism-mode', new TextEncoder().encode(mode)),
  ];
}

// ---- Main -------------------------------------------------------------

async function main(): Promise<void> {
  const contractWasm = await Deno.readFile(CONTRACT_WASM_PATH);
  const contractWasmHash = Hash.digest(contractWasm);

  // Standalone publishing node. The genesis carries a single signature
  // output funded to our publisher key. We then anchor the three publish
  // blocks to that genesis. No network plugins, no fetch handlers --
  // everything lives in-process.
  const privateKey = secp.utils.randomPrivateKey();
  const publicKey = secp.getPublicKey(privateKey, true);
  const genesis = composeGenesisPacket([makeSignatureOutput(publicKey, 1)]);

  const scaffold = new Scaffold({ genesis, privateKey, enableLogging: false });

  // These blocks each carry multiple raw outputs (blob + metadata), so
  // they bypass the narrow Scaffold.put and submit through DraftManager
  // directly.
  const draftManager = scaffold.context.draftManager;
  const publishOutputs = (outputs: Output[], label: string): Hash => {
    const draft = draftManager.addReady({ claims: [], outputs, declaredWeight: 1 });
    const result = draftManager.solidify([draft]);
    if (!result.ok) throw new Error(`failed to publish ${label}`);
    return result.block.hash;
  };

  // 1) Publish the contract WASM blob via the HASH_CONTRACT pattern.
  publishOutputs(blobPublishBlock(contractWasm), 'contract WASM blob');

  // 2) Publish the transform-mode contract block.
  publishOutputs(contractBlockOutputs(contractWasmHash, 'transform'), 'transform contract block');

  // 3) Publish the verify-mode contract block.
  publishOutputs(contractBlockOutputs(contractWasmHash, 'verify'), 'verify contract block');

  // Sanity-check: both contract blocks should be loadable as contracts via
  // the auto-registered wasmContractPlugin. This confirms the blob beacon
  // (block #1) is discoverable by the plugin's resolveBlob path.
  const contractHost = scaffold.context.execution;
  const transformContract = contractHost.getContract(transformResult.hash);
  if (!transformContract) {
    throw new Error('transform contract did not load via WasmContractPlugin');
  }
  const verifyContract = contractHost.getContract(verifyResult.hash);
  if (!verifyContract) {
    throw new Error('verify contract did not load via WasmContractPlugin');
  }

  await scaffold.close();

  // Emit results as a single JSON object on stdout.
  // deno-lint-ignore no-console
  console.log(JSON.stringify(
    {
      contractWasm: {
        path: CONTRACT_WASM_PATH.pathname,
        bytes: contractWasm.byteLength,
        hash: contractWasmHash.toHex(),
        publishedBlock: blobResult.hash.toHex(),
      },
      transformContract: {
        block: transformResult.hash.toHex(),
        mode: 'transform',
      },
      verifyContract: {
        block: verifyResult.hash.toHex(),
        mode: 'verify',
      },
      publisher: {
        publicKey: Array.from(publicKey).map((b) => b.toString(16).padStart(2, '0')).join(''),
      },
    },
    null,
    2,
  ));
}

await main();
