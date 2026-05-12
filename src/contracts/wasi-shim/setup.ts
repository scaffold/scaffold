// WASI shim contract setup helper.
//
// Builds the `modules` graph + `wasi_setup` record map for a contract whose
// `run` entry is the WASI shim, stacking it above the user's WASI program
// WASM blob. See `docs/design/wasi-shim.md` for the design.
//
// Usage:
//
//   import { Hash } from 'scaffold.io/util/Hash.ts';
//   import { buildWasiContract } from 'scaffold.io/contracts/wasi-shim/setup.ts';
//   const shimBytes = await Deno.readFile('.../dist/wasi-shim.wasm');
//   const progBytes = await Deno.readFile('hello.wasm');
//   const c = buildWasiContract({
//     shimWasm: shimBytes,
//     programWasm: progBytes,
//     setup: { argv: ['hello'], env: { LANG: 'C' } },
//   });
//   // -> c.records (with `modules` + `wasi_setup`) and c.blobs (keyed by hex hash)

import { Hash } from '../../util/Hash.ts';

// Schema mirrors `docs/design/wasi-shim.md#wasi_setup-record`. Optional
// fields fall back to the documented defaults inside the shim, not here.
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

export interface BuildWasiContractOpts {
  /** Bytes of the wasi-shim WASM blob (compiled from `src/contracts/wasi-shim/`). */
  shimWasm: Uint8Array;
  /** Bytes of the user's WASI snapshot preview 1 program. */
  programWasm: Uint8Array;
  /** Optional wasi_setup config. Omitting it uses the shim's documented defaults. */
  setup?: WasiSetup;
}

export interface BuildWasiContractResult {
  /** Ready for `composeGenesisPacket(recordsMapToOutputs(records))` or the snapshot helper. */
  records: Record<string, unknown>;
  /** Hex-hash → bytes; pass to `assertContractTraceSnapshot` as `blobs`. */
  blobs: Record<string, Uint8Array>;
  /** Hashes, surfaced so callers can reference them in sequence expectations. */
  shimHash: Hash;
  programHash: Hash;
}

export function buildWasiContract(opts: BuildWasiContractOpts): BuildWasiContractResult {
  const shimHash = Hash.digest(opts.shimWasm);
  const programHash = Hash.digest(opts.programWasm);
  const shimHex = shimHash.toHex();
  const progHex = programHash.toHex();

  const modules = {
    base: {
      version: 20250510,
      imports: { run: 'wasi_shim:run' },
    },
    layers: {
      wasi_shim: {
        wasmHash: shimHex,
        imports: {
          'scaffold_env.*': 'base:*',
          'program._start': 'program:_start',
          // Cross-memory accessor function imports. See WasmModules.ts:
          // `@read` / `@write` markers synthesise a JS memcpy closure.
          'program_mem.read_bytes':  'program:memory@read',
          'program_mem.write_bytes': 'program:memory@write',
        },
      },
      program: {
        wasmHash: progHex,
        imports: {
          // Every preview1 call routes to the shim's flat exports.
          'wasi_snapshot_preview1.*': 'wasi_shim:*',
        },
      },
    },
  };

  const records: Record<string, unknown> = { modules };
  if (opts.setup !== undefined) records.wasi_setup = opts.setup;

  return {
    records,
    blobs: { [shimHex]: opts.shimWasm, [progHex]: opts.programWasm },
    shimHash,
    programHash,
  };
}
