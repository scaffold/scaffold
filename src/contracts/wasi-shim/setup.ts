// TS helper to compose a Scaffold contract block that runs an unmodified
// WASI snapshot preview 1 program through the shim. Produces the records +
// blobs map that drops straight into `assertContractTraceSnapshot` (and,
// later, into the production contract publisher).
//
// Mirror to abi/proc.zig: `EXIT_ZERO_REASON` MUST stay byte-equal to the
// constant declared there. proc_exit(0) traps via scaffold_env.reject with
// this exact message; `withExitRecognition` swallows it.

import { encodeBase64Url } from '@std/encoding/base64url';
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
  layers: Record<string, {
    wasmHash: string;
    imports: Record<string, string>;
  }>;
}

function buildModulesSpec(shimHashHex: string, programHashHex: string): ModulesSpec {
  // The graph is the canonical stack from docs/design/wasi-shim.md
  // (Architecture section). Two layers, bidirectional function imports
  // resolved by the linker's lazy nameTable + the @read/@write accessor
  // markers for the program memory bridge.
  return {
    base: {
      version: MODULES_VERSION,
      imports: { run: 'wasi_shim:run' },
    },
    layers: {
      wasi_shim: {
        wasmHash: shimHashHex,
        imports: {
          'program._start': 'program:_start',
          'program_mem.read_bytes': 'program:memory@read',
          'program_mem.write_bytes': 'program:memory@write',
          'scaffold_env.*': 'base:*',
        },
      },
      program: {
        wasmHash: programHashHex,
        imports: { 'wasi_snapshot_preview1.*': 'wasi_shim:*' },
      },
    },
  };
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

interface OutputNamespaceJson {
  contract: string;
  /** base64url-encoded params bytes (clean JSON, no escaping). */
  params: string;
}

/**
 * Encode the `output_namespaces` manifest. NOTE: this record is currently
 * informational — the contract block format does not validate program
 * outputs against it (that lives elsewhere, and is a no-op for v1). It is
 * still produced because the design doc requires it on the block, and
 * downstream verification is expected to grow into reading it.
 */
function encodeOutputNamespaces(
  namespaces: ReadonlyArray<{ contract: Hash; params: Uint8Array }>,
): Uint8Array {
  const arr: OutputNamespaceJson[] = namespaces.map((ns) => ({
    contract: ns.contract.toHex(),
    params: encodeBase64Url(ns.params),
  }));
  return new TextEncoder().encode(JSON.stringify(arr));
}

// -- Public API -------------------------------------------------------

/**
 * Compose a contract block that stacks the WASI shim above `programBytes`.
 *
 * @param opts.shimBytes the wasi-shim.wasm blob (load via `loadShim()`).
 * @param opts.programBytes the WASI preview1 program WASM.
 * @param opts.setup wasi_setup config; defaults applied for any missing field.
 * @param opts.outputNamespaces (contract, params) pairs the program may emit
 *   into. Pass `[]` for programs that only write to `/out/debug`.
 */
export function buildContractRecords(opts: {
  shimBytes: Uint8Array;
  programBytes: Uint8Array;
  setup?: WasiSetup;
  outputNamespaces?: ReadonlyArray<{ contract: Hash; params: Uint8Array }>;
}): ShimContractInputs {
  const shimHash = Hash.digest(opts.shimBytes);
  const programHash = Hash.digest(opts.programBytes);
  const shimHex = shimHash.toHex();
  const programHex = programHash.toHex();

  const modules = buildModulesSpec(shimHex, programHex);
  const wasi_setup = encodeWasiSetup(opts.setup ?? {});
  const output_namespaces = encodeOutputNamespaces(opts.outputNamespaces ?? []);

  return {
    records: { modules, wasi_setup, output_namespaces },
    blobs: { [shimHex]: opts.shimBytes, [programHex]: opts.programBytes },
  };
}

/**
 * Read the built shim WASM from `src/contracts/wasi-shim/dist/wasi-shim.wasm`.
 * Throws if the file is missing — the build pipeline will eventually wire
 * this automatically.
 */
export async function loadShim(): Promise<Uint8Array> {
  const url = new URL('./dist/wasi-shim.wasm', import.meta.url);
  try {
    return await Deno.readFile(url);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(
        `wasi-shim: dist/wasi-shim.wasm not found. ` +
          `Run \`cd src/contracts/wasi-shim && zig build\` first.`,
      );
    }
    throw err;
  }
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
