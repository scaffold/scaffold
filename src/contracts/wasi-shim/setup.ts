// TS helper to compose a Scaffold contract block that runs an unmodified
// WASI snapshot preview 1 program through the shim. Produces the records +
// blobs map that drops straight into `assertContractTraceSnapshot` (and,
// later, into the production contract publisher).
//
// Mirror to abi/proc.zig: `EXIT_ZERO_REASON` MUST stay byte-equal to the
// constant declared there. proc_exit(0) traps via scaffold_env.reject with
// this exact message; `withExitRecognition` swallows it.

import { Hash } from '../../util/Hash.ts';
import { ContractRejection } from '../../core/ContractEnv.ts';

// -- Public types -----------------------------------------------------

export interface WasiSetup {
  argv?: string[];
  env?: Record<string, string>;
  cwd?: string;
  preopens?: string[];
  stdin?: string;
  stdout?: string;
  stderr?: string;
  extra_fds?: Record<string, string>;
}

/**
 * Sentinel string `proc_exit(0)` traps with. Mirrors `abi/proc.zig`'s
 * `EXIT_ZERO_REASON`. Tests + run wrappers catch `ContractRejection` with
 * this exact message and convert to a clean return.
 */
export const EXIT_ZERO_REASON = '__SCAFFOLD_WASI_EXIT_ZERO__';

/**
 * Result of `buildContractRecords`. Drop these directly into
 * `assertContractTraceSnapshot`'s `records` and `blobs`.
 */
export interface ShimContractInputs {
  records: Record<string, unknown>;
  blobs: Record<string, Uint8Array>;
}

// -- Defaults ---------------------------------------------------------

// Single source of truth for the wasi_setup defaults. The shim applies the
// same defaults itself (see `src/contracts/wasi-shim/src/scaffold/setup.zig`),
// so any field that matches a default is omitted from the serialised JSON to
// keep the on-block record small and snapshot-stable.
const DEFAULTS = {
  argv: ['program'] as readonly string[],
  env: {} as Record<string, string>,
  cwd: '/',
  preopens: ['/in', '/out', '/scratch', '/dev'] as readonly string[],
  stdin: '/dev/null',
  stdout: '/out/debug',
  stderr: '/out/debug',
  extra_fds: {} as Record<string, string>,
} as const;

// -- Module-graph construction ----------------------------------------

/** ABI version bumped in lockstep with `wasm-abi.md` and `BaseSpec.version`. */
const MODULES_VERSION = 20250510;

interface ModulesSpec {
  base: {
    version: number;
    imports: Record<string, string>;
  };
  layers: Array<{
    key: string;
    wasmHash: string;
    imports: Record<string, string>;
  }>;
}

function buildModulesSpec(
  shimHashHex: string,
  programHashHex: string,
  jsonWbHashHex?: string,
): ModulesSpec {
  // The graph is the canonical stack from docs/design/wasi-shim.md
  // (Architecture section). Two layers, bidirectional function imports
  // resolved by the linker's lazy nameTable + the @read/@write accessor
  // markers for the program memory bridge.
  //
  // Array order = instantiation order: wasi_shim is instantiated first; its
  // function import of `program._start` is resolved lazily through the
  // forwarder, so program (instantiated after) can satisfy it without an
  // ordering conflict.
  const imports: Record<string, string> = { run: 'wasi_shim:run' };
  const layers: ModulesSpec['layers'] = [
    {
      key: 'wasi_shim',
      wasmHash: shimHashHex,
      imports: {
        'program._start': 'program:_start',
        'program_mem.read_bytes': 'program:memory@read',
        'program_mem.write_bytes': 'program:memory@write',
        'scaffold_env.*': 'base:*',
      },
    },
    {
      key: 'program',
      wasmHash: programHashHex,
      imports: { 'wasi_snapshot_preview1.*': 'wasi_shim:*' },
    },
  ];

  // Optional generic JSON walker/builder layer. When present, the contract's
  // params/data are serialized/deserialized by json-wb (so any tool reads and
  // writes them the same way) rather than by the program itself. It is the
  // entry layer for the build/walk modes; it has its own memory and only
  // imports the scaffold builder/walker host surface.
  if (jsonWbHashHex !== undefined) {
    imports.build_params = 'json_wb:build_params';
    imports.build_data = 'json_wb:build_data';
    imports.walk_params = 'json_wb:walk_params';
    imports.walk_data = 'json_wb:walk_data';
    layers.push({
      key: 'json_wb',
      wasmHash: jsonWbHashHex,
      imports: {
        'scaffold_builder.*': 'base:*',
        'scaffold_walker.*': 'base:*',
      },
    });
  }

  return { base: { version: MODULES_VERSION, imports }, layers };
}

// -- wasi_setup serialisation -----------------------------------------

/**
 * Encode a `WasiSetup` value as the bytes that go on the contract block.
 *
 * Two stability rules baked in:
 *   1. **Sorted keys**: top-level keys come out in a fixed order regardless
 *      of caller insertion order. The shim's parser doesn't care, but
 *      consistent output matters for snapshot tests, content addressing,
 *      and human diffs.
 *   2. **Omit defaults**: any field equal to its documented default is
 *      dropped from the JSON. The shim re-applies the same defaults, so
 *      transmitting them is wasted bytes; omitting them also keeps the
 *      record minimal when authors only override one field.
 */
function encodeWasiSetup(setup: WasiSetup): Uint8Array {
  const out: Record<string, unknown> = {};
  // Iterate the defaults map for deterministic key order — every key the
  // serialiser knows about appears here.
  if (setup.argv !== undefined && !arrayEquals(setup.argv, DEFAULTS.argv)) {
    out.argv = setup.argv;
  }
  if (setup.cwd !== undefined && setup.cwd !== DEFAULTS.cwd) {
    out.cwd = setup.cwd;
  }
  if (setup.env !== undefined && !recordEquals(setup.env, DEFAULTS.env)) {
    out.env = setup.env;
  }
  if (setup.extra_fds !== undefined && !recordEquals(setup.extra_fds, DEFAULTS.extra_fds)) {
    out.extra_fds = setup.extra_fds;
  }
  if (setup.preopens !== undefined && !arrayEquals(setup.preopens, DEFAULTS.preopens)) {
    out.preopens = setup.preopens;
  }
  if (setup.stderr !== undefined && setup.stderr !== DEFAULTS.stderr) {
    out.stderr = setup.stderr;
  }
  if (setup.stdin !== undefined && setup.stdin !== DEFAULTS.stdin) {
    out.stdin = setup.stdin;
  }
  if (setup.stdout !== undefined && setup.stdout !== DEFAULTS.stdout) {
    out.stdout = setup.stdout;
  }
  return new TextEncoder().encode(JSON.stringify(out));
}

function arrayEquals<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function recordEquals(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) if (a[k] !== b[k]) return false;
  return true;
}

// -- output_namespaces serialisation ----------------------------------

/**
 * Encode the `output_namespaces` record: the concatenated 32-byte CONTRACT
 * hashes of the namespaces the program may emit into, in order, with no length
 * prefix (an empty set is zero bytes). This is the format
 * `WasmContractPlugin.readOutputNamespaces` parses and that wasm-abi.md
 * mandates -- namespaces are keyed by contract hash, so a namespace's `params`
 * is not part of its on-chain identity and is not encoded here.
 */
function encodeOutputNamespaces(
  namespaces: ReadonlyArray<{ contract: Hash; params: Uint8Array }>,
): Uint8Array {
  const out = new Uint8Array(namespaces.length * 32);
  namespaces.forEach((ns, i) => out.set(ns.contract.toBytes(), i * 32));
  return out;
}

// -- Public API -------------------------------------------------------

/**
 * Compose a contract block that stacks the WASI shim above `programBytes`.
 *
 * @param opts.shimBytes the wasi-shim.wasm blob (load via `loadShim()` from
 *   `./loadShim.ts` in Deno, or read the file yourself in other runtimes).
 * @param opts.programBytes the WASI preview1 program WASM.
 * @param opts.setup wasi_setup config; defaults applied for any missing field.
 * @param opts.outputNamespaces the namespaces (by contract hash) the program
 *   may emit into; only `.contract` is encoded (see `encodeOutputNamespaces`).
 *   Pass `[]` for programs that only write to `/out/debug` or self-claimed
 *   `/out/record/*` outputs.
 */
export function buildContractRecords(opts: {
  shimBytes: Uint8Array;
  programBytes: Uint8Array;
  setup?: WasiSetup;
  outputNamespaces?: ReadonlyArray<{ contract: Hash; params: Uint8Array }>;
}): ShimContractInputs {
  const shimHash = Hash.digest(opts.shimBytes);
  const programHash = Hash.digest(opts.programBytes);

  const records = buildContractRecordsFromHashes({
    shimHash,
    programHash,
    setup: opts.setup,
    outputNamespaces: opts.outputNamespaces,
  });

  return {
    records,
    blobs: { [shimHash.toHex()]: opts.shimBytes, [programHash.toHex()]: opts.programBytes },
  };
}

/**
 * Build just the records (no blobs) for a shim+program contract, given the
 * blob *hashes* rather than the bytes. Use this when the blobs are already
 * available to verifiers (e.g. seeded as well-known blocks), so there is no
 * need to re-publish them. Returns `modules` as a JS object (its on-chain form
 * is JSON) plus the `wasi_setup` / `output_namespaces` byte records.
 */
export function buildContractRecordsFromHashes(opts: {
  shimHash: Hash;
  programHash: Hash;
  /** Optional generic JSON walker/builder layer (json-wb) for params/data. */
  jsonWbHash?: Hash;
  setup?: WasiSetup;
  outputNamespaces?: ReadonlyArray<{ contract: Hash; params: Uint8Array }>;
}): ShimContractInputs['records'] {
  return {
    modules: buildModulesSpec(
      opts.shimHash.toHex(),
      opts.programHash.toHex(),
      opts.jsonWbHash?.toHex(),
    ),
    wasi_setup: encodeWasiSetup(opts.setup ?? {}),
    output_namespaces: encodeOutputNamespaces(opts.outputNamespaces ?? []),
  };
}

/**
 * Catches `ContractRejection` with `EXIT_ZERO_REASON` and converts to
 * `undefined`. Re-throws every other rejection. Use around the contract
 * entry call when you want `proc_exit(0)` to look like a clean return.
 */
export function withExitRecognition<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ContractRejection && err.message === EXIT_ZERO_REASON) {
      return undefined;
    }
    throw err;
  }
}
