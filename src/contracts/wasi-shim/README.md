# WASI Shim

A Zig-built `wasm32-freestanding` module that lets an unmodified
`wasi_snapshot_preview1` program (compiled by clang/rustc/tinygo, etc.) run as
a Scaffold contract. The shim sits between the program and `scaffold_env` in a
stacking [`modules`](../../../docs/protocol/wasm-abi.md#stacking) graph,
translating WASI host calls into scaffold operations via a virtual filesystem
(`/in/*`, `/out/*`, `/scratch/*`, `/dev/*`).

## Quick-start

```sh
# Build the shim (produces dist/wasi-shim.wasm).
zig build wasi-shim
# Or via the deno task that the test suite uses:
deno task build:wasi-shim

# Native unit tests for the pure-logic modules (vfs, prng, json, ...).
zig build test

# End-to-end snapshot tests through the in-process WASM transport.
deno task test:wasi
```

## File map

- `build.zig` — produces `dist/wasi-shim.wasm` (`wasm32-freestanding`,
  `ReleaseSmall` by default) plus the `zig build test` step.
- `dist/wasi-shim.wasm` — built artifact; the TS helper hashes it at runtime.
- `setup.ts` — TypeScript helper that composes a Scaffold contract block from
  `(shimBytes, programBytes, wasi_setup)`. Also exports `EXIT_ZERO_REASON` and
  `withExitRecognition` for callers that drive `program._start` directly.
- `src/main.zig` — module entry; declares `scaffold_env.*` / `program.*` /
  `program_mem.*` imports and exports the WASI ABI plus `run`.
- `src/abi/` — WASI snapshot preview 1 wire layer.
- `src/vfs/` — virtual filesystem (WASI-agnostic, scaffold-agnostic).
- `src/scaffold/` — wraps `scaffold_env.*`, parses `wasi_setup`, maps shim
  paths onto scaffold calls.
- `src/state.zig`, `src/prng.zig`, `src/json.zig` — per-run state, deterministic
  PRNG, freestanding JSON subset parser.

For the full design — protocol fit, virtual-filesystem layout, determinism
mappings, rights model, memory layout — see
[`docs/design/wasi-shim.md`](../../../docs/design/wasi-shim.md). For the
per-call decisions that informed the implementation (errno picks, oflag
interactions, FD-table semantics) see
[`docs/design/wasi-shim-decisions.md`](../../../docs/design/wasi-shim-decisions.md).

## From a contract author's POV

Use `setup.ts` to compose the block:

```ts
import { buildContractRecords } from 'scaffold.io/contracts/wasi-shim/setup.ts';
const { records, blobs } = buildContractRecords({
  shimBytes,        // load wasi-shim.wasm
  programBytes,     // your unmodified WASI preview1 program
  setup: { argv: ['program', '/in/params'], cwd: '/scratch' },
  outputNamespaces: [],  // (contract, params) pairs your program emits into
});
```

`records` and `blobs` drop straight into the snapshot helper for tests, or
into a Scaffold publisher for production. Defaults are applied for any
missing `wasi_setup` field; defaults that match the documented value are
omitted from the serialised JSON to keep the on-block record small and
content-addressing stable.

## v1 surface

What works:

- 12-call MVP: `proc_exit`, `clock_time_get`, `clock_res_get`, `random_get`,
  `args_get`/`args_sizes_get`, `environ_get`/`environ_sizes_get`, `fd_write`,
  `fd_read`, `fd_close`, `fd_seek`, `fd_fdstat_get`, `fd_fdstat_set_flags`,
  `fd_filestat_get`, `fd_readdir`, `path_open`, `path_filestat_get` plus the
  `fd_prestat_*` helpers needed by wasi-libc preopen scanning.
- Virtual filesystem: `/in/{mode,timestamp,contract_hash,params,body/...,fetch/...,contract_metadata/...}`,
  `/out/{record/...,output/...,debug}`, `/scratch/*` (in-memory, dropped on
  exit), `/dev/{null,zero,random,urandom}`.
- Deterministic everywhere: PRNG seeded from `H(contract_hash || timestamp_ms || params)`,
  `MONOTONIC` is a per-call counter, `REALTIME` is the block timestamp.
- QuickJS boots end-to-end (`tests/WasiShimQuickJS.test.ts`).

What's `ENOTSUP`:

- Sockets (`sock_*`).
- Symlinks / hardlinks (`path_symlink`, `path_link`, `path_readlink`).
- `poll_oneoff` for anything other than `CLOCK_MONOTONIC` subscriptions.
- `proc_raise`, `fd_renumber`, `fd_tell` (until a real program needs them).
- The scaffold `walk_*` / `build_*` modes — only `run` is exposed.

For the full out-of-scope list and the post-v1 roadmap (wasi-testsuite
vendoring, differential testing against `wasmtime`, larger real-world
programs like CPython), see the design doc's Testing Strategy and
Out-of-Scope sections.
