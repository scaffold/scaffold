// Protocol spec: docs/protocol/wasm-abi.md#stacking
//
// Wire format, validation, and graph linker for the `modules` JSON record
// that describes a WASM contract's module graph.
//
// Shape:
//
//   {
//     "base": {
//       "version": 20250510,
//       "imports": {
//         "<scaffold_entry_name>": "<layerKey>:<exportName>",
//         ...
//       }
//     },
//     "layers": {
//       "<layerKey>": {
//         "wasmHash": "<64-char hex content hash>",
//         "imports": {
//           "<ns>.<field>":   "<layerKey>:<exportName>",
//           "<ns>.<field>":   "base:<bareScaffoldName>",
//           "<prefix>.*":     "<layerKey>:<exportPrefix>*"
//         }
//       },
//       ...
//     }
//   }
//
// Resolution model
// ----------------
// Every cross-module / cross-base reference is EXPLICIT in `imports`. There
// is no global view, no implicit defaults, no fallback. A WASM-declared
// import `(import "X" "Y" ...)` MUST be present in the layer's `imports`
// map (or match a wildcard); otherwise loading is a hard error.
//
// `imports` values are `"<layerKey>:<exportName>"` references. `layerKey`
// can be any key in `layers`, or the special string `"base"` which refers
// to scaffold's mode-appropriate ContractEnv host exports.
//
// Wildcards: an entry like `"foo.*": "bar:*"` matches all imports whose key
// starts with `"foo."`; the suffix replaces the `*` in the target. Required
// shape:
//   1. `*` appears at the end of BOTH the key and the value.
//   2. The character immediately before `*` is `.` in the key, and `.` or
//      `:` in the value.
//
// `base.imports`
// --------------
// Defines what scaffold invokes for each mode. `base.imports["run"]` is the
// `<layerKey>:<exportName>` scaffold calls for `runVerifying` /
// `runGenerating`. Similarly `walk_params`, `walk_data`, `build_params`,
// `build_data`. The transport also uses the SAME layer's `alloc` export as
// the host bridge's allocator.
//
// Cycles
// ------
// The graph can be cyclic (a WASI shim imports `_start` from the wasi
// blob, while the blob imports `wasi_snapshot_preview1.fd_write` from the
// shim). Resolution uses JS forwarder closures over a shared name table
// populated AFTER all layers are instantiated, so cycles work. Forwarders
// add a JS-call hop per cross-edge.

import { Hash } from '../../util/Hash.ts';

// -- Wire types --------------------------------------------------------

export interface BaseSpec {
  /** ABI revision integer date (e.g. 20250510). */
  version: number;
  /**
   * Scaffold-facing entry points. Keys are scaffold mode names (`run`,
   * `walk_params`, `walk_data`, `build_params`, `build_data`); values are
   * `"<layerKey>:<exportName>"` references identifying which layer's export
   * scaffold invokes for that mode.
   */
  imports: Record<string, string>;
}

export interface LayerSpec {
  /** 64-char hex content hash of the WASM blob. */
  wasmHash: string;
  /**
   * Linking instructions for this module's declared WASM imports.
   * Required for every declared import (or covered by a wildcard).
   */
  imports?: Record<string, string>;
}

export interface ModulesSpec {
  base: BaseSpec;
  layers: Record<string, LayerSpec>;
}

// -- Parsed / normalised types -----------------------------------------

/** A target reference parsed from `"<layerKey>:<exportName>"`. */
export interface TargetRef {
  readonly layerKey: string;
  readonly exportName: string;
}

/** One pattern entry parsed from a layer's `imports`. */
export type ImportPattern =
  | { readonly kind: 'literal'; readonly key: string; readonly target: TargetRef }
  | {
    readonly kind: 'wildcard';
    /** Prefix up to (but not including) the trailing `.*`. */
    readonly keyPrefix: string;
    readonly targetLayerKey: string;
    /** Target export-name prefix up to (but not including) the trailing `*`. */
    readonly targetExportPrefix: string;
  };

export interface NormalisedLayer {
  readonly key: string;
  readonly blobHash: Hash;
  readonly imports: ImportPattern[];
}

export interface NormalisedModules {
  readonly base: {
    readonly version: number;
    readonly imports: ReadonlyMap<string, TargetRef>;
  };
  readonly layers: NormalisedLayer[];
  readonly byKey: ReadonlyMap<string, NormalisedLayer>;
}

// -- Compiled-stack runtime form ---------------------------------------

export interface CompiledLayer {
  readonly key: string;
  readonly module: WebAssembly.Module;
  readonly imports: ImportPattern[];
}

export interface CompiledModules {
  readonly base: NormalisedModules['base'];
  readonly layers: CompiledLayer[];
  readonly byKey: ReadonlyMap<string, CompiledLayer>;
}

// -- Parsing helpers ---------------------------------------------------

function parseTargetRef(raw: string, context: string): TargetRef {
  const colonIdx = raw.indexOf(':');
  if (colonIdx <= 0 || colonIdx === raw.length - 1) {
    throw new Error(
      `${context}: target ${JSON.stringify(raw)} must have the form "<layerKey>:<exportName>"`,
    );
  }
  return {
    layerKey: raw.slice(0, colonIdx),
    exportName: raw.slice(colonIdx + 1),
  };
}

function parseImportEntry(key: string, value: string, layerKey: string): ImportPattern {
  const context = `modules.layers[${JSON.stringify(layerKey)}].imports[${JSON.stringify(key)}]`;
  const keyHasWild = key.endsWith('*');
  const valueHasWild = value.endsWith('*');
  if (keyHasWild !== valueHasWild) {
    throw new Error(
      `${context}: wildcard "*" must appear at the end of BOTH key and value, or neither ` +
        `(got key=${JSON.stringify(key)}, value=${JSON.stringify(value)})`,
    );
  }

  if (keyHasWild) {
    // Key must be "<prefix>.*".
    if (key.length < 3 || key[key.length - 2] !== '.') {
      throw new Error(
        `${context}: wildcard key ${
          JSON.stringify(key)
        } must end with ".*" (the char before "*" must be ".")`,
      );
    }
    const keyPrefix = key.slice(0, -2);
    // Value must be "<layerKey>:<exportPrefix>*" where the char before "*"
    // is "." OR "*" comes immediately after ":".
    const colonIdx = value.indexOf(':');
    if (colonIdx <= 0) {
      throw new Error(
        `${context}: wildcard value ${
          JSON.stringify(value)
        } must include ":" between layerKey and export prefix`,
      );
    }
    const targetLayerKey = value.slice(0, colonIdx);
    const afterColon = value.slice(colonIdx + 1);
    if (afterColon === '' || !afterColon.endsWith('*')) {
      throw new Error(`${context}: wildcard value ${JSON.stringify(value)} must end with "*"`);
    }
    const targetExportPrefix = afterColon.slice(0, -1);
    if (targetExportPrefix.length > 0 && !targetExportPrefix.endsWith('.')) {
      throw new Error(
        `${context}: wildcard value ${
          JSON.stringify(value)
        }: the character before "*" must be "." (or "*" must immediately follow ":")`,
      );
    }
    return { kind: 'wildcard', keyPrefix, targetLayerKey, targetExportPrefix };
  }

  return { kind: 'literal', key, target: parseTargetRef(value, context) };
}

// -- Parser + structural validation ------------------------------------

export function parseModules(recordBody: Uint8Array): NormalisedModules {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(recordBody));
  } catch (err) {
    throw new Error(`modules record is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('modules record must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  // base
  if (typeof obj.base !== 'object' || obj.base === null || Array.isArray(obj.base)) {
    throw new Error('modules.base must be an object');
  }
  const baseObj = obj.base as Record<string, unknown>;
  if (typeof baseObj.version !== 'number' || !Number.isInteger(baseObj.version)) {
    throw new Error(
      `modules.base.version must be an integer (got ${JSON.stringify(baseObj.version)})`,
    );
  }
  if (
    typeof baseObj.imports !== 'object' || baseObj.imports === null ||
    Array.isArray(baseObj.imports)
  ) {
    throw new Error('modules.base.imports must be an object');
  }
  const baseImports = new Map<string, TargetRef>();
  for (const [k, v] of Object.entries(baseObj.imports as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new Error(`modules.base.imports[${JSON.stringify(k)}] must be a string`);
    }
    baseImports.set(k, parseTargetRef(v, `modules.base.imports[${JSON.stringify(k)}]`));
  }

  // layers
  if (typeof obj.layers !== 'object' || obj.layers === null || Array.isArray(obj.layers)) {
    throw new Error('modules.layers must be an object');
  }
  const layersObj = obj.layers as Record<string, unknown>;
  const layerKeys = Object.keys(layersObj);
  if (layerKeys.length === 0) {
    throw new Error('modules.layers must contain at least one layer');
  }

  const layers: NormalisedLayer[] = [];
  const byKey = new Map<string, NormalisedLayer>();
  const seenHashes = new Set<string>();

  for (const layerKey of layerKeys) {
    if (layerKey === 'base') {
      throw new Error('modules.layers: layer key "base" is reserved (refers to scaffold host)');
    }
    if (layerKey.includes(':') || layerKey.includes('.') || layerKey.includes('*')) {
      throw new Error(
        `modules.layers: layer key ${JSON.stringify(layerKey)} must not contain ":", ".", or "*"`,
      );
    }
    const layer = layersObj[layerKey];
    if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) {
      throw new Error(`modules.layers[${JSON.stringify(layerKey)}] must be an object`);
    }
    const layerObj = layer as Record<string, unknown>;
    if (typeof layerObj.wasmHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(layerObj.wasmHash)) {
      throw new Error(
        `modules.layers[${JSON.stringify(layerKey)}].wasmHash must be a 64-char hex string`,
      );
    }
    const normalisedHex = layerObj.wasmHash.toLowerCase();
    if (seenHashes.has(normalisedHex)) {
      throw new Error(
        `modules.layers: duplicate wasmHash ${normalisedHex} at layer ${JSON.stringify(layerKey)}`,
      );
    }
    seenHashes.add(normalisedHex);

    const importsObj = layerObj.imports;
    const patterns: ImportPattern[] = [];
    if (importsObj !== undefined) {
      if (typeof importsObj !== 'object' || importsObj === null || Array.isArray(importsObj)) {
        throw new Error(
          `modules.layers[${JSON.stringify(layerKey)}].imports must be an object`,
        );
      }
      for (const [k, v] of Object.entries(importsObj as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          throw new Error(
            `modules.layers[${JSON.stringify(layerKey)}].imports[${
              JSON.stringify(k)
            }] must be a string`,
          );
        }
        patterns.push(parseImportEntry(k, v, layerKey));
      }
    }

    const layerEntry: NormalisedLayer = {
      key: layerKey,
      blobHash: Hash.fromHex(normalisedHex),
      imports: patterns,
    };
    layers.push(layerEntry);
    byKey.set(layerKey, layerEntry);
  }

  // Cross-reference checks.
  const layerExists = (key: string) => key === 'base' || byKey.has(key);
  for (const [k, ref] of baseImports) {
    if (ref.layerKey === 'base') {
      throw new Error(
        `modules.base.imports[${JSON.stringify(k)}]: target layer cannot be "base"`,
      );
    }
    if (!layerExists(ref.layerKey)) {
      throw new Error(
        `modules.base.imports[${JSON.stringify(k)}] references unknown layer ${
          JSON.stringify(ref.layerKey)
        }`,
      );
    }
  }
  for (const layer of layers) {
    for (const pat of layer.imports) {
      const layerKeyRef = pat.kind === 'literal' ? pat.target.layerKey : pat.targetLayerKey;
      if (!layerExists(layerKeyRef)) {
        throw new Error(
          `modules.layers[${JSON.stringify(layer.key)}].imports references unknown layer ${
            JSON.stringify(layerKeyRef)
          }`,
        );
      }
    }
  }

  return {
    base: { version: baseObj.version, imports: baseImports },
    layers,
    byKey,
  };
}

// -- Resolution: declared import -> TargetRef --------------------------

/**
 * Resolve a declared WASM import `(import "ns" "field" ...)` against a
 * layer's parsed `imports` patterns. Throws if no match (strict mode).
 *
 * Match order: literal first, then longest-prefix wildcard.
 */
export function resolveImport(
  declaredNamespace: string,
  declaredField: string,
  patterns: readonly ImportPattern[],
  layerKey: string,
): TargetRef {
  const dotted = `${declaredNamespace}.${declaredField}`;
  for (const pat of patterns) {
    if (pat.kind === 'literal' && pat.key === dotted) return pat.target;
  }
  let best: { pat: Extract<ImportPattern, { kind: 'wildcard' }>; prefixLen: number } | null = null;
  for (const pat of patterns) {
    if (pat.kind !== 'wildcard') continue;
    if (dotted.startsWith(pat.keyPrefix + '.')) {
      const len = pat.keyPrefix.length;
      if (!best || len > best.prefixLen) best = { pat, prefixLen: len };
    }
  }
  if (best) {
    const matchedSuffix = dotted.slice(best.pat.keyPrefix.length + 1);
    return {
      layerKey: best.pat.targetLayerKey,
      exportName: best.pat.targetExportPrefix + matchedSuffix,
    };
  }
  throw new Error(
    `modules.layers[${
      JSON.stringify(layerKey)
    }].imports: no entry for declared import \`${declaredNamespace}.${declaredField}\` (strict mode -- every declared import must be listed)`,
  );
}

// -- Stack instantiation -----------------------------------------------

// deno-lint-ignore no-explicit-any
type ImportFn = (...args: any[]) => any;

export interface LoadModulesResult {
  /** Maps layerKey -> instance.exports. */
  readonly exportsByKey: ReadonlyMap<string, Record<string, unknown>>;
}

/**
 * Instantiate every layer with JS forwarders for cross-edge references.
 * Forwarders close over a shared nameTable populated after all layers
 * complete instantiation, so cyclic dependencies work.
 *
 * `scaffoldExports` is keyed by BARE export names (e.g., `"emit_output"`).
 * It's surfaced in the nameTable under `"base:<bareName>"` keys.
 */
export async function loadModules(
  compiled: CompiledModules,
  scaffoldExports: Record<string, unknown>,
  memory: WebAssembly.Memory,
): Promise<LoadModulesResult> {
  if (compiled.layers.length === 0) {
    throw new Error('CompiledModules.layers must be non-empty');
  }

  const nameTable = new Map<string, ImportFn>();
  const makeForwarder = (target: TargetRef, srcLayerKey: string, declared: string): ImportFn =>
  (
    ...args: unknown[]
  ) => {
    const key = `${target.layerKey}:${target.exportName}`;
    const fn = nameTable.get(key);
    if (!fn) {
      throw new Error(
        `Stack layer ${JSON.stringify(srcLayerKey)}: unresolved import \`${declared}\` -> ` +
          `${key} (target not found in nameTable)`,
      );
    }
    return fn(...args);
  };

  const importsPerLayer = compiled.layers.map((layer) => {
    const out: Record<string, Record<string, unknown>> = { env: { memory } };
    const declared = WebAssembly.Module.imports(layer.module);
    for (const imp of declared) {
      if (imp.module === 'env' && imp.name === 'memory') continue;
      const target = resolveImport(imp.module, imp.name, layer.imports, layer.key);
      const dotted = `${imp.module}.${imp.name}`;
      (out[imp.module] ??= {})[imp.name] = makeForwarder(target, layer.key, dotted);
    }
    return out;
  });

  const instances: WebAssembly.Instance[] = [];
  for (let i = 0; i < compiled.layers.length; i++) {
    const instance = await WebAssembly.instantiate(
      compiled.layers[i].module,
      importsPerLayer[i] as WebAssembly.Imports,
    );
    instances.push(instance);
  }

  // Populate nameTable.
  for (const [name, fn] of Object.entries(scaffoldExports)) {
    if (typeof fn === 'function') nameTable.set(`base:${name}`, fn as ImportFn);
  }
  const exportsByKey = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < compiled.layers.length; i++) {
    const layer = compiled.layers[i];
    const exports = instances[i].exports as Record<string, unknown>;
    exportsByKey.set(layer.key, exports);
    for (const [name, fn] of Object.entries(exports)) {
      if (typeof fn === 'function') {
        nameTable.set(`${layer.key}:${name}`, fn as ImportFn);
      }
    }
  }

  return { exportsByKey };
}
