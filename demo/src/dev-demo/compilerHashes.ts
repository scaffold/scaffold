import echoWasmUrl from './fixtures/echo.wasm?url';
import { makeRecordOutput } from 'scaffold.io/contracts/RecordContract.ts';
import type { Scaffold } from 'scaffold.io/Scaffold.ts';
import type { Hash } from 'scaffold.io/util/Hash.ts';
import type { Lang } from './examples/index.ts';

// Bottom-of-stack marker required by WasmContractPlugin for single-module
// contracts. See docs/protocol/wasm-abi.md#stacking.
const LAYERS_DEFAULT = new TextEncoder().encode('[{}]');

let cachedEchoBytes: Uint8Array | undefined;

async function loadEchoBytes(): Promise<Uint8Array> {
  if (cachedEchoBytes) return cachedEchoBytes;
  const response = await fetch(echoWasmUrl);
  if (!response.ok) {
    throw new Error(`Failed to load echo.wasm fixture: ${response.status}`);
  }
  cachedEchoBytes = new Uint8Array(await response.arrayBuffer());
  return cachedEchoBytes;
}

/**
 * Publishes the C0 echo `.wasm` as a contract block onto the given Scaffold
 * and returns the published block hash. Until real per-language compiler
 * contracts exist (Workstream C), every language tab uses this same hash --
 * the echo contract simply emits the input params as an output, which is
 * enough for the UI to demonstrate the full compile + invoke roundtrip.
 */
export async function publishEchoContract(scaffold: Scaffold): Promise<Hash> {
  const bytes = await loadEchoBytes();
  // The echo contract block carries two custom record outputs ("wasm" and
  // "wasm_layers"); neither pattern matches the unified put/send shapes,
  // so we drive DraftManager directly.
  const draftManager = scaffold.context.draftManager;
  const draft = draftManager.addReady({
    claims: [],
    outputs: [
      makeRecordOutput('wasm', bytes),
      makeRecordOutput('wasm_layers', LAYERS_DEFAULT),
    ],
    declaredWeight: 1,
  });
  const result = draftManager.solidify([draft]);
  if (!result.ok) {
    throw new Error(
      'publishEchoContract: DraftManager.solidify returned no block (parked or awaitingAnchor)',
    );
  }
  return result.block.hash;
}

/** Map of language id -> compiler block hash for the active Scaffold. */
export type CompilerHashes = Record<Lang, Hash | null>;

/**
 * Build the per-language compiler-hash map. Until real compilers exist,
 * every entry points at the same echo block.
 */
export function buildCompilerHashes(echoHash: Hash): CompilerHashes {
  return {
    typescript: echoHash,
    javascript: echoHash,
    go: echoHash,
    python: echoHash,
    zig: echoHash,
    rust: echoHash,
    cpp: echoHash,
    c: echoHash,
    assemblyscript: echoHash,
    sqlite: echoHash,
  };
}
