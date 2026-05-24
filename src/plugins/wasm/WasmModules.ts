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
//       },
//       "memories": {
//         "<memoryName>": { "initial": 16, "maximum": 4096, "shared": true }
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
// to scaffold's mode-appropriate ContractEnv host exports and any memories
// declared in `base.memories`.
//
// Imports may resolve to any WASM import kind (function, memory, table,
// global). The kind is read from `WebAssembly.Module.imports()`. Function
// imports go through JS forwarder closures (lazy, cyclic-safe). Memory /
// table / global imports are bound eagerly at instantiate time, so cycles
// across these kinds are rejected.
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
// `base.memories`
// ---------------
// Optional. Names scaffold-provided `WebAssembly.Memory` instances that
// layers can import (referenced as `"base:<memoryName>"`). Created fresh
// per `loadModules` call; not shared across calls. `shared: true` is
// required when the chosen entry memory will be used under the Atomics
// transport.
//
// Memory ownership
// ----------------
// Each layer has its own memory: either declared (`(memory ...)`) and
// optionally exported, or imported from another layer or from
// `base.memories`. The entry layer's memory is the one scaffold's host
// bridge reads/writes (the destination of `alloc`). For each layer, we
// track its "primary" memory as either its exported `memory` field or
// (failing that) the first WASM memory it imports.
//
// Cycles
// ------
// The graph can be cyclic for function imports (a WASI shim imports
// `_start` from the wasi blob, while the blob imports
// `wasi_snapshot_preview1.fd_write` from the shim). Function-cycle
// resolution uses JS forwarder closures over a shared name table populated
// AFTER all layers are instantiated. Forwarders add a JS-call hop per
// cross-edge.
//
// Memory / table / global cycles are REJECTED at load: these kinds bind to
// concrete values at instantiate time, so the dependency graph must be
// acyclic. We topologically sort layers by their non-function deps and
// instantiate in that order.

import { Hash } from '../../util/Hash.ts';

// -- Wire types --------------------------------------------------------

/** Spec for a scaffold-provided `WebAssembly.Memory` referenced via `base:<name>`. */
export interface MemorySpec {
  /** Initial size in 64-KiB pages. */
  initial: number;
  /** Max pages; if omitted, no maximum (and host may cap via max_memory_pages). */
  maximum?: number;
  /** SAB-backed memory; required when the entry memory is used under the Atomics transport. */
  shared?: boolean;
}

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
  /**
   * Scaffold-provided memories. Each entry creates one `WebAssembly.Memory`
   * fresh per `loadModules` call. Layers reference these as `"base:<name>"`.
   */
  memories?: Record<string, MemorySpec>;
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

/**
 * A target reference parsed from `"<layerKey>:<exportName>"` or, with the
 * cross-memory accessor markers from the WASI shim design,
 * `"<layerKey>:<memoryExportName>@read"` / `"...@write"`. When `accessor`
 * is set, the import is synthesised at instantiate time as a closure that
 * memcpys between the source layer's primary memory and the target layer's
 * named memory export -- the import's WASM signature must be
 * `(prog_off: i32, peer_off: i32, len: i32) -> ()`.
 */
export interface TargetRef {
  readonly layerKey: string;
  readonly exportName: string;
  readonly accessor?: 'read' | 'write';
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

export interface NormalisedBase {
  readonly version: number;
  readonly imports: ReadonlyMap<string, TargetRef>;
  /** Always present (possibly empty). */
  readonly memories: ReadonlyMap<string, MemorySpec>;
}

export interface NormalisedModules {
  readonly base: NormalisedBase;
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
  readonly base: NormalisedBase;
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
  const layerKey = raw.slice(0, colonIdx);
  const rest = raw.slice(colonIdx + 1);
  // Accessor markers: "<memoryExport>@read" / "@write" select a synthesised
  // cross-memory function import (see TargetRef docstring + the WASI shim
  // design doc, "program memory bridge" section).
  const atIdx = rest.lastIndexOf('@');
  if (atIdx > 0) {
    const accessor = rest.slice(atIdx + 1);
    if (accessor === 'read' || accessor === 'write') {
      return { layerKey, exportName: rest.slice(0, atIdx), accessor };
    }
    throw new Error(
      `${context}: target ${JSON.stringify(raw)} has unknown accessor ${
        JSON.stringify(accessor)
      } (expected "@read" or "@write")`,
    );
  }
  return { layerKey, exportName: rest };
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

  // base.memories (optional)
  const baseMemories = new Map<string, MemorySpec>();
  if (baseObj.memories !== undefined) {
    if (
      typeof baseObj.memories !== 'object' || baseObj.memories === null ||
      Array.isArray(baseObj.memories)
    ) {
      throw new Error('modules.base.memories must be an object');
    }
    for (const [name, raw] of Object.entries(baseObj.memories as Record<string, unknown>)) {
      const context = `modules.base.memories[${JSON.stringify(name)}]`;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`${context} must be an object`);
      }
      const spec = raw as Record<string, unknown>;
      if (typeof spec.initial !== 'number' || !Number.isInteger(spec.initial) || spec.initial < 0) {
        throw new Error(`${context}.initial must be a non-negative integer`);
      }
      const memSpec: MemorySpec = { initial: spec.initial };
      if (spec.maximum !== undefined) {
        if (
          typeof spec.maximum !== 'number' || !Number.isInteger(spec.maximum) ||
          spec.maximum < spec.initial
        ) {
          throw new Error(`${context}.maximum must be an integer >= initial`);
        }
        memSpec.maximum = spec.maximum;
      }
      if (spec.shared !== undefined) {
        if (typeof spec.shared !== 'boolean') {
          throw new Error(`${context}.shared must be a boolean`);
        }
        memSpec.shared = spec.shared;
      }
      baseMemories.set(name, memSpec);
    }
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
    base: { version: baseObj.version, imports: baseImports, memories: baseMemories },
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
  /**
   * The entry layer's "primary" memory (the one the host bridge reads/writes
   * and the one `alloc` is presumed to allocate into).
   */
  readonly entryMemory: WebAssembly.Memory;
  /**
   * For each layer, its "primary" memory: its exported `memory` if present,
   * else the first WASM memory it imports. Useful to bridges that need to
   * access non-entry layer memory (e.g. a WASI shim reading program memory).
   */
  readonly memoryByLayerKey: ReadonlyMap<string, WebAssembly.Memory>;
}

/**
 * Test-instrumentation hook: every cross-layer JS-forwarder call fires an
 * `enter` event before invoking the target and an `exit` event after. The
 * exit event carries `result` on a normal return or `error` on a thrown
 * exception. Production code does not pass a tracer; `tests/helpers/
 * contractSnapshot.ts` uses this to render call sequences.
 */
export interface TracerEvent {
  readonly phase: 'enter' | 'exit';
  /** Layer key that declared the import. Never `"base"` (base doesn't call layers). */
  readonly srcLayer: string;
  /** Resolved target -- the layer + export the call routes to. */
  readonly target: TargetRef;
  /** The `"<ns>.<field>"` form of the import as declared in the WASM module. */
  readonly declared: string;
  /** Raw wire-level args (i32 / i64 / etc., not semantic). */
  readonly args: readonly unknown[];
  /** Only on `phase === "exit"` and only when the call returned normally. */
  readonly result?: unknown;
  /** Only on `phase === "exit"` and only when the call threw. */
  readonly error?: unknown;
}

export type Tracer = (event: TracerEvent) => void;

/**
 * Host export classified by call shape. The transport tells `loadModules`
 * which exports are sync (called from JS, returns synchronously) vs async
 * (called from JS, returns a Promise). For `kind: 'async'` base imports,
 * the wire-time import value is `new WebAssembly.Suspending(forwarder)`
 * so WASM can call them as if sync while JSPI handles the suspension.
 *
 * Per-layer WASM exports are always treated as sync from JS (WASM exports
 * return synchronously even if they internally suspend); only `base:` host
 * exports carry the distinction.
 */
export type ExportEntry =
  | { kind: 'sync'; fn: (...args: unknown[]) => unknown }
  | { kind: 'async'; fn: (...args: unknown[]) => Promise<unknown> };

/**
 * Wrap a sync host function as a `kind: 'sync'` entry. The generic
 * constraint accepts any concrete arg-typed function -- WASM imports
 * arrive at the JS boundary as raw args; the host function's typed
 * parameters just describe how it interprets them.
 */
export function syncExport<Fn extends (...args: never[]) => unknown>(fn: Fn): ExportEntry {
  return { kind: 'sync', fn: fn as unknown as (...args: unknown[]) => unknown };
}

/** Wrap an async host function as a `kind: 'async'` entry. */
export function asyncExport<Fn extends (...args: never[]) => Promise<unknown>>(
  fn: Fn,
): ExportEntry {
  return {
    kind: 'async',
    fn: fn as unknown as (...args: unknown[]) => Promise<unknown>,
  };
}

/**
 * Instantiate every layer with kind-aware import resolution.
 *
 * The supplied `compiled.layers` array IS the instantiation order. Memory /
 * table / global imports must target a strictly lower-indexed layer (or
 * `base:` memories); we validate this up front and reject otherwise. There
 * is no topo-sort. The contract is "layer N may only depend, at instantiate
 * time, on layers 0..N-1 and `base:*`."
 *
 * Function imports are resolved through a single shared exports table
 * (`exports: Map<string, ExportEntry>`):
 *   - Base entries are pre-populated from `scaffoldExports` before the
 *     instantiation loop runs.
 *   - Each layer's WASM exports are added to the table immediately after
 *     `WebAssembly.instantiate` returns, before the next layer wires up.
 *
 * Function imports use a forwarder that looks up the table at call time
 * (so cycles work: layer N may import a function from layer M > N; the
 * forwarder fires only after both layers are instantiated). For
 * `base:` targets whose entry is `kind: 'async'`, the import value handed
 * to WASM is `new WebAssembly.Suspending(forwarder)` -- required because
 * `Suspending` instances are not callable from JavaScript and must be the
 * literal import value.
 *
 * Constraint on WASM start functions: a layer's `(start ...)` (if present)
 * may only call into base or already-instantiated lower layers. Calls into
 * not-yet-instantiated higher layers will fire the forwarder and throw at
 * lookup time. This is unavoidable: there is no order that lets two layers'
 * start functions mutually call each other.
 *
 * `scaffoldExports` is keyed by BARE export names (e.g., `"emit_output"`).
 * Surfaced in the exports table under `"base:<bareName>"`.
 */
export async function loadModules(
  compiled: CompiledModules,
  scaffoldExports: Record<string, ExportEntry>,
  entry: TargetRef,
  tracer?: Tracer,
): Promise<LoadModulesResult> {
  if (compiled.layers.length === 0) {
    throw new Error('CompiledModules.layers must be non-empty');
  }

  // --- Pass 0: create scaffold-provided memories ----------------------
  const baseMemories = new Map<string, WebAssembly.Memory>();
  for (const [name, spec] of compiled.base.memories) {
    const memDescriptor: WebAssembly.MemoryDescriptor = { initial: spec.initial };
    if (spec.maximum !== undefined) memDescriptor.maximum = spec.maximum;
    if (spec.shared) {
      (memDescriptor as WebAssembly.MemoryDescriptor & { shared: boolean }).shared = true;
    }
    baseMemories.set(name, new WebAssembly.Memory(memDescriptor));
  }

  // --- Pass 1: classify each layer's declared imports by kind, gather
  // memory-deps ------------------------------------------------------
  interface ResolvedImport {
    readonly namespace: string;
    readonly name: string;
    readonly kind: WebAssembly.ImportExportKind;
    readonly target: TargetRef;
  }
  const declaredByLayer = new Map<string, ResolvedImport[]>();
  const memoryDeps = new Map<string, Set<string>>();
  for (const layer of compiled.layers) {
    const resolved: ResolvedImport[] = [];
    const deps = new Set<string>();
    for (const imp of WebAssembly.Module.imports(layer.module)) {
      const target = resolveImport(imp.module, imp.name, layer.imports, layer.key);
      resolved.push({ namespace: imp.module, name: imp.name, kind: imp.kind, target });
      if (imp.kind !== 'function' && target.layerKey !== 'base') {
        deps.add(target.layerKey);
      }
    }
    declaredByLayer.set(layer.key, resolved);
    memoryDeps.set(layer.key, deps);
  }

  // --- Pass 2: validate non-function imports target lower-indexed layers
  // The supplied `compiled.layers` array is the instantiation order. Memory
  // / table / global imports bind eagerly, so their target must already be
  // instantiated when this layer wires up -- i.e. strictly lower index, or
  // `base:` memories. Function imports are lazy via forwarders and may
  // cycle freely.
  const indexByKey = new Map<string, number>();
  for (let i = 0; i < compiled.layers.length; i++) {
    indexByKey.set(compiled.layers[i].key, i);
  }
  for (let i = 0; i < compiled.layers.length; i++) {
    const layer = compiled.layers[i];
    for (const dep of memoryDeps.get(layer.key)!) {
      const depIdx = indexByKey.get(dep);
      if (depIdx === undefined) {
        throw new Error(
          `modules.layers[${
            JSON.stringify(layer.key)
          }]: non-function import references unknown layer ${JSON.stringify(dep)}`,
        );
      }
      if (depIdx >= i) {
        throw new Error(
          `modules.layers[${JSON.stringify(layer.key)}]: non-function imports must target ` +
            `a strictly lower-indexed layer (or base:* memories). Layer ${
              JSON.stringify(layer.key)
            } (index ${i}) imports from ${JSON.stringify(dep)} (index ${depIdx}).`,
        );
      }
    }
  }

  // --- Pass 3: instantiate layers in supplied order ------------------
  //
  // `exports` is the single shared table that resolves function-import
  // forwarders at call time. Base entries are populated up front; per-layer
  // entries are added immediately after each `WebAssembly.instantiate`
  // returns. (See ExportEntry doc above for the kind: 'sync' | 'async'
  // distinction and how it drives Suspending wrapping at wire time.)
  const exports = new Map<string, ExportEntry>();
  for (const [name, entry] of Object.entries(scaffoldExports)) {
    exports.set(`base:${name}`, entry);
  }
  const makeForwarder = (target: TargetRef, srcLayerKey: string, declared: string): ImportFn =>
  (
    ...args: unknown[]
  ) => {
    const key = `${target.layerKey}:${target.exportName}`;
    const entry = exports.get(key);
    if (!entry) {
      throw new Error(
        `Stack layer ${JSON.stringify(srcLayerKey)}: unresolved import \`${declared}\` -> ` +
          `${key} (target not in exports table)`,
      );
    }
    const fn = entry.fn;
    if (!tracer) return fn(...args);
    tracer({ phase: 'enter', srcLayer: srcLayerKey, target, declared, args });
    try {
      const result = fn(...args);
      tracer({ phase: 'exit', srcLayer: srcLayerKey, target, declared, args, result });
      return result;
    } catch (err) {
      tracer({ phase: 'exit', srcLayer: srcLayerKey, target, declared, args, error: err });
      throw err;
    }
  };

  // Cross-memory accessor forwarder. WASI shim design: imports a virtual
  // `program_mem.{read,write}_bytes(prog_off, peer_off, len)` function that
  // memcpys between the source layer's primary memory and the target layer's
  // named memory export. Both memories are resolved lazily at call time so
  // we don't need to topo-order accessor imports the way we do for direct
  // memory imports (the underlying read_bytes/write_bytes WASM signature is
  // pure function-passing; the cycle that exists between shim and program
  // is broken by the function-forwarder pattern, same as ordinary calls).
  const makeAccessorForwarder = (
    target: TargetRef,
    srcLayerKey: string,
    declared: string,
    accessor: 'read' | 'write',
  ): ImportFn =>
  (...args: unknown[]) => {
    const traceCall = (run: () => void): void => {
      if (!tracer) {
        run();
        return;
      }
      tracer({ phase: 'enter', srcLayer: srcLayerKey, target, declared, args });
      try {
        run();
        tracer({ phase: 'exit', srcLayer: srcLayerKey, target, declared, args });
      } catch (err) {
        tracer({ phase: 'exit', srcLayer: srcLayerKey, target, declared, args, error: err });
        throw err;
      }
    };
    traceCall(() => {
      const peerMem = memoryByLayerKey.get(srcLayerKey);
      if (!peerMem) {
        throw new Error(
          `Stack layer ${JSON.stringify(srcLayerKey)}: cross-memory accessor \`${declared}\` ` +
            `cannot resolve source layer's primary memory (this layer doesn't export or ` +
            `import a memory)`,
        );
      }
      const targetExports = exportsByKey.get(target.layerKey);
      const targetMem = targetExports?.[target.exportName];
      if (!(targetMem instanceof WebAssembly.Memory)) {
        throw new Error(
          `Stack layer ${JSON.stringify(srcLayerKey)}: cross-memory accessor \`${declared}\` ` +
            `target ${target.layerKey}:${target.exportName} is not a WebAssembly.Memory ` +
            `(got ${targetMem === undefined ? 'undefined' : typeof targetMem})`,
        );
      }
      // Args are `(target_off: i32, peer_off: i32, len: i32)`. The
      // semantics differ between read and write: `read` copies from target
      // memory into peer memory; `write` is the reverse.
      const targetOff = args[0] as number;
      const peerOff = args[1] as number;
      const len = args[2] as number;
      if (accessor === 'read') {
        const src = new Uint8Array(targetMem.buffer, targetOff, len);
        new Uint8Array(peerMem.buffer, peerOff, len).set(src);
      } else {
        const src = new Uint8Array(peerMem.buffer, peerOff, len);
        new Uint8Array(targetMem.buffer, targetOff, len).set(src);
      }
    });
  };

  const exportsByKey = new Map<string, Record<string, unknown>>();
  const memoryByLayerKey = new Map<string, WebAssembly.Memory>();

  // Suspending is only available when JSPI is enabled in the runtime; load
  // lazily so the in-process / Atomics paths don't require it.
  const SuspendingCtor =
    (WebAssembly as unknown as { Suspending?: new (fn: unknown) => unknown }).Suspending;

  for (const layer of compiled.layers) {
    const layerKey = layer.key;
    const resolved = declaredByLayer.get(layerKey)!;
    const out: Record<string, Record<string, unknown>> = {};
    // Cache the first imported memory we wire up so we can record it as
    // the layer's primary memory if the module doesn't export `memory`.
    let firstImportedMemory: WebAssembly.Memory | undefined;

    for (const r of resolved) {
      const dotted = `${r.namespace}.${r.name}`;
      let value: unknown;
      if (r.kind === 'function') {
        if (r.target.accessor) {
          value = makeAccessorForwarder(r.target, layerKey, dotted, r.target.accessor);
        } else {
          const fwd = makeForwarder(r.target, layerKey, dotted);
          // Suspending-wrap iff the target is known async at wire time.
          // Only base entries can be async (per-layer WASM exports are
          // always sync from JS); for upward layer refs the target isn't
          // in the table yet but it's guaranteed sync, so the plain
          // forwarder is correct.
          const wireEntry = r.target.layerKey === 'base'
            ? exports.get(`base:${r.target.exportName}`)
            : undefined;
          if (wireEntry?.kind === 'async') {
            if (!SuspendingCtor) {
              throw new Error(
                `Stack layer ${JSON.stringify(layerKey)}: import ${JSON.stringify(dotted)} ` +
                  `targets async base export ${JSON.stringify(r.target.exportName)} but the ` +
                  `runtime does not support WebAssembly.Suspending. Use a sync transport.`,
              );
            }
            value = new SuspendingCtor(fwd);
          } else {
            value = fwd;
          }
        }
      } else if (r.kind === 'memory') {
        if (r.target.layerKey === 'base') {
          const mem = baseMemories.get(r.target.exportName);
          if (!mem) {
            throw new Error(
              `modules.layers[${JSON.stringify(layerKey)}].imports[${JSON.stringify(dotted)}]: ` +
                `target base:${r.target.exportName} not found in base.memories`,
            );
          }
          value = mem;
          firstImportedMemory ??= mem;
        } else {
          const targetExports = exportsByKey.get(r.target.layerKey);
          if (!targetExports) {
            // Pass 2 should have rejected this; if we land here it's an
            // internal invariant break.
            throw new Error(
              `modules.layers[${JSON.stringify(layerKey)}].imports[${JSON.stringify(dotted)}]: ` +
                `target ${r.target.layerKey}:${r.target.exportName} not yet instantiated ` +
                `(internal error: Pass 2 layer-order validation should have rejected this)`,
            );
          }
          const candidate = targetExports[r.target.exportName];
          if (!(candidate instanceof WebAssembly.Memory)) {
            throw new Error(
              `modules.layers[${JSON.stringify(layerKey)}].imports[${JSON.stringify(dotted)}]: ` +
                `target ${r.target.layerKey}:${r.target.exportName} is not a WebAssembly.Memory ` +
                `(got ${candidate === undefined ? 'undefined' : typeof candidate})`,
            );
          }
          value = candidate;
          firstImportedMemory ??= candidate;
        }
      } else {
        // table / global: eager binding like memory; no `base.tables` /
        // `base.globals` yet, so only layer:layer references are valid.
        if (r.target.layerKey === 'base') {
          throw new Error(
            `modules.layers[${JSON.stringify(layerKey)}].imports[${JSON.stringify(dotted)}]: ` +
              `${r.kind} imports from "base" not supported (base exposes functions and memories)`,
          );
        }
        const targetExports = exportsByKey.get(r.target.layerKey);
        const candidate = targetExports?.[r.target.exportName];
        if (candidate === undefined) {
          throw new Error(
            `modules.layers[${JSON.stringify(layerKey)}].imports[${JSON.stringify(dotted)}]: ` +
              `target ${r.target.layerKey}:${r.target.exportName} not found`,
          );
        }
        value = candidate;
      }
      (out[r.namespace] ??= {})[r.name] = value;
    }

    const instance = await WebAssembly.instantiate(layer.module, out as WebAssembly.Imports);
    const layerExports = instance.exports as Record<string, unknown>;
    exportsByKey.set(layerKey, layerExports);
    // Publish this layer's function exports into the shared table before
    // the next layer wires up, so a higher layer's forwarder can resolve
    // its downward references. (Per-layer WASM exports are always sync
    // from JS, even when JSPI is in play.)
    for (const [name, fn] of Object.entries(layerExports)) {
      if (typeof fn === 'function') {
        exports.set(`${layerKey}:${name}`, {
          kind: 'sync',
          fn: fn as (...args: unknown[]) => unknown,
        });
      }
    }

    // Determine the layer's primary memory.
    const primary = layerExports.memory instanceof WebAssembly.Memory
      ? (layerExports.memory as WebAssembly.Memory)
      : firstImportedMemory;
    if (primary) memoryByLayerKey.set(layerKey, primary);
  }

  // --- Pass 5: resolve entry memory ---------------------------------
  if (entry.layerKey === 'base') {
    throw new Error(`loadModules: entry.layerKey cannot be "base"`);
  }
  const entryMemory = memoryByLayerKey.get(entry.layerKey);
  if (!entryMemory) {
    throw new Error(
      `loadModules: entry layer ${JSON.stringify(entry.layerKey)} has no associated memory ` +
        `(no exported \`memory\` and no imported memory)`,
    );
  }

  return { exportsByKey, entryMemory, memoryByLayerKey };
}
