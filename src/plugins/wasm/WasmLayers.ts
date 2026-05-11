// Protocol spec: docs/protocol/wasm-abi.md#stacking
//
// Wire format, structural validation, and import-composition for the
// `wasm_layers` JSON record that pins a WASM contract's module stack.
//
// A `wasm_layers` record is mandatory on every WASM contract block. It's a
// non-empty JSON array of LayerSpec entries, bottom-to-top. The LAST entry's
// `wasmHash` is null/omitted -- its bytes live in the contract block's `wasm`
// record. All other entries' `wasmHash` is a 64-char hex string referring to
// a content-addressed WASM blob fetched via `{ contract: HASH_CONTRACT,
// params: blobHash }`.
//
// `mapImports` lets a higher layer rebind its declared imports onto the
// layer below's exports. Keys are `"<import_namespace>.<import_field>"`,
// values are bare lower-export names. Missing entries default to 1:1 on the
// field name.
//
// `env.memory` is reserved for the runtime-supplied shared memory; a
// mapImports entry whose key is exactly `"env.memory"` is rejected at load.

import { Hash, HASH_SIZE } from '../../util/Hash.ts';

// -- LayerSpec wire format ---------------------------------------------

/**
 * One entry in `wasm_layers`. The last entry's `wasmHash` is omitted /
 * null and refers to the primary (the block's `wasm` record body).
 */
export interface LayerSpec {
  /** Content hash of the WASM blob, hex-encoded. Null/omitted for the primary. */
  wasmHash?: string | null;
  /** Rebinding of this layer's declared imports onto the layer below's exports. */
  mapImports?: Record<string, string>;
}

/** Normalised stack description, post structural validation. */
export interface NormalisedStack {
  /** Bottom-to-top lower layers, with parsed blob hashes. Empty for single-module contracts. */
  readonly layers: { readonly blobHash: Hash; readonly mapImports?: Record<string, string> }[];
  /** Primary entry; bytes come from the block's `wasm` record. */
  readonly primary: { readonly mapImports?: Record<string, string> };
}

// -- CompiledStack -- runtime form passed into transports --------------

/** A single layer with its compiled WebAssembly.Module and rebinding map. */
export interface StackEntry {
  readonly module: WebAssembly.Module;
  readonly mapImports?: Record<string, string>;
}

/** Result of `WasmContractAdapter.compileStack()`, passed to each transport call. */
export interface CompiledStack {
  /** Bottom-to-top lower layers, excluding the primary. Empty for single-module contracts. */
  readonly layers: StackEntry[];
  /** Primary (top) layer. Always present. Its `mapImports` rebinds onto the topmost lower layer's exports. */
  readonly primary: StackEntry;
}

// -- Parser + structural validation ------------------------------------

/**
 * Parse and structurally validate a `wasm_layers` JSON record body.
 * Throws Error on any structural problem; the error message identifies
 * the violated rule.
 */
export function parseWasmLayers(recordBody: Uint8Array): NormalisedStack {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(recordBody));
  } catch (err) {
    throw new Error(
      `wasm_layers record is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(raw)) {
    throw new Error('wasm_layers must be a JSON array');
  }
  if (raw.length === 0) {
    throw new Error('wasm_layers must be a non-empty array');
  }

  // Pass 1: validate per-entry shape, collect primary entries with their indices.
  const seenHashes = new Set<string>();
  const layers: NormalisedStack['layers'][number][] = [];
  const primaryEntries: { index: number; mapImports?: Record<string, string> }[] = [];

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`wasm_layers[${i}] must be an object`);
    }
    const layerSpec = entry as LayerSpec;
    validateMapImports(layerSpec.mapImports, i);
    const isPrimary = layerSpec.wasmHash === null || layerSpec.wasmHash === undefined;
    if (isPrimary) {
      primaryEntries.push({ index: i, mapImports: layerSpec.mapImports });
      continue;
    }
    const hashHex = layerSpec.wasmHash as string;
    if (typeof hashHex !== 'string' || !/^[a-fA-F0-9]{64}$/.test(hashHex)) {
      throw new Error(
        `wasm_layers[${i}].wasmHash must be a 64-char hex string; got ${JSON.stringify(hashHex)}`,
      );
    }
    const normalised = hashHex.toLowerCase();
    if (seenHashes.has(normalised)) {
      throw new Error(`wasm_layers: duplicate wasmHash ${normalised} at index ${i}`);
    }
    seenHashes.add(normalised);
    layers.push({
      blobHash: Hash.fromHex(normalised),
      mapImports: layerSpec.mapImports,
    });
  }

  // Pass 2: enforce primary count + position rules.
  if (primaryEntries.length === 0) {
    throw new Error(
      'wasm_layers: at least one entry must omit wasmHash (the primary); ' +
        'no such entry found',
    );
  }
  if (primaryEntries.length > 1) {
    throw new Error(
      `wasm_layers: only one entry may omit wasmHash (the primary); ` +
        `found ${primaryEntries.length} omitted-hash entries at indices [${
          primaryEntries.map((p) => p.index).join(', ')
        }]`,
    );
  }
  const primaryEntry = primaryEntries[0];
  if (primaryEntry.index !== raw.length - 1) {
    throw new Error(
      `wasm_layers: the primary entry (omitted wasmHash) must be last; ` +
        `found at index ${primaryEntry.index} of ${raw.length} entries`,
    );
  }

  return { layers, primary: { mapImports: primaryEntry.mapImports } };
}

function validateMapImports(
  mapImports: Record<string, string> | undefined,
  layerIndex: number,
): void {
  if (mapImports === undefined) return;
  if (typeof mapImports !== 'object' || mapImports === null || Array.isArray(mapImports)) {
    throw new Error(`wasm_layers[${layerIndex}].mapImports must be an object`);
  }
  for (const [key, value] of Object.entries(mapImports)) {
    if (key === 'env.memory') {
      throw new Error(
        `wasm_layers[${layerIndex}].mapImports: key "env.memory" is reserved ` +
          `for the runtime-supplied shared memory`,
      );
    }
    if (typeof value !== 'string') {
      throw new Error(
        `wasm_layers[${layerIndex}].mapImports[${JSON.stringify(key)}] must be a string`,
      );
    }
    if (!key.includes('.')) {
      throw new Error(
        `wasm_layers[${layerIndex}].mapImports key ${
          JSON.stringify(key)
        } must be a dotted "namespace.field" string`,
      );
    }
  }
}

// -- Import composition ------------------------------------------------

/**
 * Compose the `WebAssembly.Imports` object for a single layer in a stack.
 *
 * `lowerExports` is the flat view of what the layer below makes available:
 *   - For the bottom layer, this is the mode-appropriate scaffold export
 *     map (`scaffold_env.*`, or `scaffold_walker.*`, or `scaffold_builder.*`).
 *   - For higher layers, it's the layer-below `instance.exports`.
 *
 * `memory` is the runtime-supplied shared linear memory; the helper always
 * injects it under `env.memory`, regardless of whether the module declares
 * an `(import "env" "memory" ...)` import.
 *
 * Per-declared-import resolution:
 *   1. Look up `"<ns>.<field>"` in `mapImports`; if present, bind to
 *      `lowerExports[mapImports[...]]`.
 *   2. Otherwise, bind to `lowerExports[field]` (default 1:1).
 *   3. Unresolved imports flow through to WebAssembly.instantiate as
 *      LinkErrors -- the error message includes the missing import name.
 *
 * @param module       WebAssembly.Module whose imports we're composing.
 * @param mapImports   Optional rebinding map; see `LayerSpec.mapImports`.
 * @param lowerExports Flat dictionary of what the layer below exports.
 * @param memory       Runtime shared memory, bound to `env.memory`.
 */
export function buildImportsForLayer(
  module: WebAssembly.Module,
  mapImports: Record<string, string> | undefined,
  lowerExports: Record<string, unknown>,
  memory: WebAssembly.Memory,
): WebAssembly.Imports {
  // deno-lint-ignore no-explicit-any
  const out: Record<string, Record<string, any>> = { env: { memory } };
  const declared = WebAssembly.Module.imports(module);
  for (const imp of declared) {
    if (imp.module === 'env' && imp.name === 'memory') continue; // already supplied
    const dotted = `${imp.module}.${imp.name}`;
    const lowerName = mapImports?.[dotted] ?? imp.name;
    const value = lowerExports[lowerName];
    // If undefined, fall through -- WebAssembly.instantiate throws a LinkError
    // pointing at the precise (module, name) pair which is good debugging info.
    (out[imp.module] ??= {})[imp.name] = value;
  }
  return out as WebAssembly.Imports;
}

// -- Required imports check --------------------------------------------

/**
 * Inspect a module's declared `wasm_layers`-related expectations and report
 * the unique blob hashes that need to be fetched (i.e. all lower layers' blob
 * hashes; the primary's bytes come from the contract block's `wasm` record).
 */
export function blobHashesToFetch(stack: NormalisedStack): Hash[] {
  return stack.layers.map((l) => l.blobHash);
}

// -- Test helpers ------------------------------------------------------

export const __testing = {
  HASH_SIZE,
};
