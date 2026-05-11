// Protocol spec: docs/protocol/wasm-abi.md#stacking
//
// Wire format, structural validation, and import-composition for the
// `wasm_layers` JSON record that pins a WASM contract's module stack.
//
// A `wasm_layers` record is mandatory on every WASM contract block. It's a
// non-empty JSON array of LayerSpec entries, bottom-to-top. EVERY entry
// carries a `wasmHash` (64-char hex content hash of a WASM blob fetched
// via `{ contract: HASH_CONTRACT, params: blobHash }`). The last entry is
// the "top" of the stack -- its `run` / `walk_*` / `build_*` export is the
// entry point.
//
// Each layer may optionally declare:
//   - `mapImports`: how this layer's WASM-declared imports resolve onto the
//     LAYER-BELOW's presented exports. Keys are dotted "namespace.field"
//     strings matching the WASM import declarations; values are bare names
//     in the lower layer's presented-exports view.
//   - `mapExports`: how this layer's exports are presented to the LAYER-ABOVE.
//     Keys are dotted "namespace.field" strings (the names the layer above
//     would see in its imports); values are bare names from this layer's
//     `instance.exports`.
//
// Resolution per declared `(import "X" "Y" ...)` on layer i+1:
//   1. If `layers[i+1].mapImports["X.Y"]` is set, the lookup name is that value.
//      Otherwise the lookup name is "X.Y" (preserving the dotted form).
//   2. The presented-exports view of layer i is built from `instance_i.exports`
//      plus the dotted entries injected by `layers[i].mapExports`.
//   3. Look up the lookup name in layer i's presented exports. If absent, try
//      the bare field name "Y" (back-compat for unmapped scaffold-style imports).
//   4. If still nothing, the import is bound to `undefined` and
//      `WebAssembly.instantiate` throws a `LinkError`.
//
// `env.memory` is reserved for the runtime-supplied shared memory; a
// mapImports entry whose key is exactly `"env.memory"` is rejected at load.

import { Hash } from '../../util/Hash.ts';

// -- LayerSpec wire format ---------------------------------------------

/**
 * One entry in `wasm_layers`. Every entry carries a `wasmHash` (the bytes
 * are fetched via HASH_CONTRACT); the last entry is the top of the stack.
 */
export interface LayerSpec {
  /** Content hash of the WASM blob, hex-encoded (64 chars). Required. */
  wasmHash: string;
  /** How this layer's declared imports resolve onto the layer below's presented exports. */
  mapImports?: Record<string, string>;
  /** How this layer's own exports are presented to the layer above. */
  mapExports?: Record<string, string>;
}

/** Normalised stack description, post structural validation. */
export interface NormalisedStack {
  /**
   * Bottom-to-top layers. Non-empty. The last entry is the top of the stack
   * (its `run` / `walk_*` / `build_*` export is invoked).
   */
  readonly layers: {
    readonly blobHash: Hash;
    readonly mapImports?: Record<string, string>;
    readonly mapExports?: Record<string, string>;
  }[];
}

// -- CompiledStack -- runtime form passed into transports --------------

/** A compiled layer with its rebinding maps. */
export interface StackEntry {
  readonly module: WebAssembly.Module;
  readonly mapImports?: Record<string, string>;
  readonly mapExports?: Record<string, string>;
}

/**
 * `WasmContractAdapter.compileStack()` result, passed to each transport call.
 * `layers` is bottom-to-top; the last entry is the top of the stack.
 */
export interface CompiledStack {
  readonly layers: StackEntry[];
}

// -- Parser + structural validation ------------------------------------

/**
 * Parse and structurally validate a `wasm_layers` JSON record body. Throws
 * Error on any structural problem; the error message identifies the violated
 * rule.
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

  const seenHashes = new Set<string>();
  const layers: NormalisedStack['layers'][number][] = [];

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`wasm_layers[${i}] must be an object`);
    }
    const layerSpec = entry as LayerSpec;
    if (typeof layerSpec.wasmHash !== 'string') {
      throw new Error(
        `wasm_layers[${i}].wasmHash is required (every layer must reference a WASM blob)`,
      );
    }
    if (!/^[a-fA-F0-9]{64}$/.test(layerSpec.wasmHash)) {
      throw new Error(
        `wasm_layers[${i}].wasmHash must be a 64-char hex string; got ${
          JSON.stringify(layerSpec.wasmHash)
        }`,
      );
    }
    const normalised = layerSpec.wasmHash.toLowerCase();
    if (seenHashes.has(normalised)) {
      throw new Error(`wasm_layers: duplicate wasmHash ${normalised} at index ${i}`);
    }
    seenHashes.add(normalised);

    validateMapImports(layerSpec.mapImports, i);
    validateMapExports(layerSpec.mapExports, i);

    layers.push({
      blobHash: Hash.fromHex(normalised),
      mapImports: layerSpec.mapImports,
      mapExports: layerSpec.mapExports,
    });
  }

  return { layers };
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

function validateMapExports(
  mapExports: Record<string, string> | undefined,
  layerIndex: number,
): void {
  if (mapExports === undefined) return;
  if (typeof mapExports !== 'object' || mapExports === null || Array.isArray(mapExports)) {
    throw new Error(`wasm_layers[${layerIndex}].mapExports must be an object`);
  }
  for (const [key, value] of Object.entries(mapExports)) {
    if (typeof value !== 'string') {
      throw new Error(
        `wasm_layers[${layerIndex}].mapExports[${JSON.stringify(key)}] must be a string`,
      );
    }
    if (!key.includes('.')) {
      throw new Error(
        `wasm_layers[${layerIndex}].mapExports key ${
          JSON.stringify(key)
        } must be a dotted "namespace.field" string`,
      );
    }
  }
}

// -- Presented-exports composition ------------------------------------

/**
 * Build the presented-exports view of a layer for the layer immediately above:
 * all instance exports keyed by their bare names, PLUS any dotted entries
 * named by `mapExports`. The result is keyed by string -- the layer-above's
 * mapImports / default-1:1 lookup will use these keys.
 *
 * For the bottom layer's "below" view, callers pass the mode-appropriate
 * scaffold flat map directly (no instance to consult).
 */
export function presentExports(
  instanceExports: Record<string, unknown>,
  mapExports: Record<string, string> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...instanceExports };
  if (mapExports) {
    for (const [dotted, exportName] of Object.entries(mapExports)) {
      out[dotted] = instanceExports[exportName];
    }
  }
  return out;
}

// -- Import composition ------------------------------------------------

/**
 * Compose the `WebAssembly.Imports` object for a single layer in a stack.
 *
 * `presentedExports` is the layer-below's exports view (the result of
 * `presentExports` for layers above the bottom, or the mode-appropriate
 * scaffold flat map for the bottom layer).
 *
 * `memory` is the runtime-supplied shared linear memory; the helper always
 * injects it under `env.memory`, regardless of whether the module declares
 * an `(import "env" "memory" ...)` import.
 *
 * Per-declared-import resolution:
 *   1. Lookup name N = mapImports["X.Y"] ?? "X.Y".
 *   2. Try presentedExports[N]; if absent, try presentedExports[Y] (the field
 *      part) as a back-compat fallback for unmapped scaffold-style imports.
 *   3. If still undefined, the import flows through to WebAssembly.instantiate
 *      which throws a LinkError pointing at the unresolved (module, name).
 */
export function buildImportsForLayer(
  module: WebAssembly.Module,
  mapImports: Record<string, string> | undefined,
  presentedExports: Record<string, unknown>,
  memory: WebAssembly.Memory,
): WebAssembly.Imports {
  // deno-lint-ignore no-explicit-any
  const out: Record<string, Record<string, any>> = { env: { memory } };
  const declared = WebAssembly.Module.imports(module);
  for (const imp of declared) {
    if (imp.module === 'env' && imp.name === 'memory') continue; // supplied
    const dotted = `${imp.module}.${imp.name}`;
    let value: unknown;
    if (mapImports && Object.prototype.hasOwnProperty.call(mapImports, dotted)) {
      // Author declared this mapping explicitly: strict lookup, no fallback.
      value = presentedExports[mapImports[dotted]];
    } else {
      // No mapping declared: try the dotted form, then bare field name
      // (back-compat for scaffold-style imports where the layer below
      // presents bare names).
      value = presentedExports[dotted];
      if (value === undefined) value = presentedExports[imp.name];
    }
    (out[imp.module] ??= {})[imp.name] = value;
  }
  return out as WebAssembly.Imports;
}
