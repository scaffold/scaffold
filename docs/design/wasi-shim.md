# WASI Shim

> Status: design draft. Speccing the in-stack shim that lets an unmodified WASI snapshot preview 1 program run as a Scaffold contract by mapping the WASI host surface onto `scaffold_env` via a virtual filesystem.

## Goal

Take a WASM module that was compiled against `wasi_snapshot_preview1` (e.g. by `clang --target=wasm32-wasi`, `rustc --target=wasm32-wasi`, or `tinygo -target=wasi`) and run it as a Scaffold contract without modification, by stacking it above a shim that translates WASI host calls into `scaffold_env` calls.

Most WASI programs targeted by this shim are **input/output-shaped** compute jobs: a compiler, an interpreter, a parser, a transformer. They consume scaffold-side inputs (`params`, `request_body`, `fetch`) as files, write scaffold-side outputs (`emit_output`) as files, and don't need scaffold-specific features (claims, forks, signatures). For those use cases, the WASI ↔ scaffold impedance match is excellent — both are byte-oriented synchronous request/response.

## Architecture

The shim is one layer in a stacking [`modules`](../protocol/wasm-abi.md#stacking) graph:

```jsonc
{
  "base": {
    "version": 20250510,
    "imports": { "run": "wasi_shim:run" }
  },
  "layers": {
    "wasi_shim": {
      "wasmHash": "...wasi-shim WASM blob hash...",
      "imports": {
        "_start": "program:_start",
        "program_mem.memory": "program:memory",
        "scaffold_env.*": "base:*"
      }
    },
    "program": {
      "wasmHash": "...the unmodified WASI program WASM blob hash...",
      "imports": {
        "wasi_snapshot_preview1.*": "wasi_shim:*"
      }
    }
  }
}
```

Each module owns its own memory (declared via `(memory (export "memory") ...)`). The shim imports the program's memory under the local name `program_mem.memory` so it can read program pointers when forwarding WASI calls. The program imports only the shim's WASI functions. No shared memory; no data-section collision.

Scaffold invokes the shim's `run`. The shim sets up state from `wasi_setup` (read via `contract_metadata`), then calls into `program:_start` (or `_initialize` for reactor modules). Each WASI host call from the program lands on the shim's flat-exported `fd_read`, `fd_write`, etc., which the shim handles by walking its in-memory FS state and, for paths backed by scaffold operations, calling into `scaffold_env` (which `imports: {"scaffold_env.*": "base:*"}` routes to scaffold).

This is the bidirectional-stack pattern: the shim depends on the program (`_start`) and the program depends on the shim (`wasi_snapshot_preview1.*`). The stacking linker resolves this via JS forwarder closures over a shared name table; no special handling required.

The contract publisher (the human who wants to run program X as a Scaffold contract) publishes a contract block with:
- A `modules` record above, naming both blob hashes.
- A `wasi_setup` record (JSON; schema below) configuring argv/env/cwd/fds.
- An `output_namespaces` record listing every namespace the program may emit into.

The shim WASM blob itself is published once (by the Scaffold authors); contract authors reference it by hash.

## Virtual Filesystem

The shim presents a fixed-shape virtual filesystem with three operational zones plus `/dev`:

```
/                       — root (preopened, lists everything below)
├── in/                  — read-only; scaffold-side inputs
│   ├── mode             — 1 byte: 0 (generate) | 1 (verify)
│   ├── timestamp        — 8 bytes LE u64; block timestamp
│   ├── contract_hash    — 32 bytes; hash of the running contract block
│   ├── params           — verifier.params bytes
│   ├── contract_metadata/0x{contract_hash_hex}/{params_encoded}/
│   │                    — read returns body bytes of contract_metadata({contract, params})
│   ├── body/0x{contract_hash_hex}/{params_encoded}/
│   │                    — read returns body bytes of requestBody({contract, params})
│   └── fetch/0x{contract_hash_hex}/{params_encoded}/{record_key_path}
│                        — read returns fetched record value; path-after-params is the record key
├── out/                 — write-only; scaffold-side outputs
│   ├── record/{record_key_path}
│   │                    — write bytes; close emits Output{RECORD_CONTRACT, key, value=0, body}
│   ├── output/0x{contract_hash_hex}/{params_encoded}/{amount_decimal}
│   │                    — write bytes; close emits Output{contract, params, value=amount, body}
│   └── debug            — write bytes; goes to ctx.logger('wasi-shim').debug, no record emitted
├── scratch/             — read/write; guaranteed empty at start, in-memory only, dropped on exit
├── dev/
│   ├── null             — read EOF, write discarded
│   ├── zero             — read returns zero bytes, write discarded
│   ├── random           — read returns infinite deterministic bytes (PRNG, see below); write discarded
│   └── urandom          — alias of /dev/random (no blocking distinction; both are instant)
└── (other paths)        — return ENOENT; not guaranteed stable across shim versions
```

The root `/` is read+writable but its layout is not guaranteed across shim versions. Authors should use the zones below it.

### Path encoding of binary values

Paths are bytes, but several segments encode binary scaffold values (32-byte hashes, variable-length params). Encoding conventions:

| Segment shape | Encoding |
|---|---|
| `contract_hash_hex` (always 32 bytes) | hex with mandatory `0x` prefix → 66 chars total: `0x` + 64 hex |
| `params_encoded` (variable length) | UTF-8 by default; `0x`-prefix to switch to hex |
| `record_key_path` (variable length, may contain `/`) | UTF-8 by default; `0x`-prefix to switch to hex |
| `amount_decimal` | base-10 decimal digits, no prefix, signed `i128` range |

Rationale for not adopting multibase: only one encoding is needed (hex), nothing else in the codebase reaches for multibase, and a single discriminator (`0x`) is dramatically less surface area than the multibase prefix table.

Edge case: if a literal record key (or params) starts with the two ASCII bytes `0x`, the author MUST encode it in hex form (`0x3078...`). The shim does not have a quoting escape. This is documented and acceptable because string keys with `0x` prefixes are vanishingly rare in practice; programs that want to use them should pass them through `0x`-hex encoding once on the way into the shim.

**Hashes are always hex** because they're never meaningful as UTF-8 — there's no ambiguity to discriminate.

### Record-key paths

A path like `/in/fetch/0x.../0x.../a/b/c` means: fetch the record output with key `"a/b/c"` (bytes `61 2f 62 2f 63`). Path segments after the params slot concatenate with `/` into a single record-key bytes value. This lets nested directory trees on the source block be browsed as nested directories in the shim, which is exactly how WASI programs expect to walk inputs.

The mapping is bijective by string concatenation; no escaping for `/` in record keys (a key containing `/` is reached by descending more directories; a key containing `..` requires `0x`-hex encoding of the whole key).

For `/out/record/`, the same rule: `/out/record/a/b/c` emits an output with record key `"a/b/c"`. Writes into nested paths implicitly create the directory tree on the output side.

### Static directory listings

`readdir` works on:
- `/` → `["in", "out", "scratch", "dev"]`
- `/in` → `["mode", "timestamp", "contract_hash", "params", "contract_metadata", "body", "fetch"]`
- `/out` → `["record", "output", "debug"]`
- `/dev` → `["null", "zero", "random", "urandom"]`
- `/scratch` and subdirectories → contents of the in-memory tree
- `/out/record` and its subdirectories — only what has been opened/written in this invocation (so a program can `readdir` a tree it built)

Dynamic directories (`/in/body/0x.../`, `/in/fetch/0x.../`, `/in/contract_metadata/0x.../`) **return `ENOTSUP` on `readdir`**. There's no way to enumerate "every key on a fetched block" through the scaffold ABI today, and faking it would mislead programs. Programs targeting these paths know the keys they want; they `open` them directly.

### Write semantics

Open creates an in-memory write buffer. Writes append to the buffer. **`close` emits the side effect once.** If the program exits with an open FD, the shim closes it automatically before returning to scaffold. This means:
- One `open` + N `write` + one `close` on `/out/record/foo` = one `emit_output`.
- Reopening the same path is allowed; each cycle emits independently. (Two `emit_output` calls with the same key. This is well-defined in the protocol — duplicate outputs are an emitter problem to avoid.)
- A write that fails (e.g. buffer exceeds `max_memory_pages`) traps; the shim does not try to recover.

### `/out/debug`

Writes to `/out/debug` are forwarded to `ctx.logger('wasi-shim').debug(...)`. Lines are flushed on each newline, with the final partial line (if any) flushed on close. The debug stream **does not emit a scaffold output** — it's purely diagnostic, visible in DevTools and `__scaffold.events`. This is the canonical sink for `stderr` and for `printf` debugging from the program.

### `/dev/random` and `/dev/urandom`

Reads return bytes from a single deterministic PRNG seeded by `H(block_hash || contract_hash)`. The stream is infinite — programs may read as much as they want. Reads from both paths consume the same stream (no separate state between them), and `random_get` WASI calls also consume from this stream. Order of consumption is deterministic because program execution is deterministic.

The construction: a counter-mode PRNG outputting `H(seed || counter)` per 32-byte block, where `counter` is a u64 advanced once per emitted block. The shim tracks `(seed, position)` as part of its state.

Writes to `/dev/random` and `/dev/urandom` are discarded (no entropy mixing — that would break determinism).

## Determinism

WASI exposes several sources of non-determinism that must be deterministically mapped:

| WASI call | Mapping |
|---|---|
| `clock_time_get(REALTIME)` | block timestamp, ms × 10^6 (WASI is nanoseconds) |
| `clock_time_get(MONOTONIC)` | strictly-increasing call counter × 1ns; starts at 0 |
| `clock_time_get(PROCESS_CPUTIME_ID)` | same as MONOTONIC |
| `clock_time_get(THREAD_CPUTIME_ID)` | same as MONOTONIC |
| `clock_res_get(*)` | constant 1 ns |
| `random_get` | bytes from the same deterministic PRNG that backs `/dev/random` (shared stream) |
| `args_get` / `args_sizes_get` | `wasi_setup.argv` |
| `environ_get` / `environ_sizes_get` | `wasi_setup.env` |
| `proc_exit(0)` | shim's `run` returns normally |
| `proc_exit(n != 0)` | shim calls `scaffold_env.reject("WASI proc_exit: <n>")` |
| `proc_raise(_)` | shim calls `scaffold_env.reject("WASI proc_raise: <sig>")` |
| `poll_oneoff` | only `CLOCK_MONOTONIC` subscriptions supported (advance the counter, return); other types → `ENOTSUP` |
| `sched_yield` | no-op return success |
| `sock_*` | `ENOTSUP` |
| `path_symlink` / `path_link` | `EROFS` everywhere except `/scratch`; in `/scratch`, `ENOTSUP` (avoid the graph cases) |

The MONOTONIC counter ensures that even programs that `sleep`-style poll on monotonic time make deterministic progress — every observation advances the counter by 1ns.

## `wasi_setup` Record

A JSON record on the contract block, key `"wasi_setup"`, body is UTF-8 JSON of:

```ts
type WasiSetup = {
  /** Program argv. Defaults to ["program"]. */
  argv?: string[];
  /** Environment variables. Order is preserved as listed. */
  env?: Record<string, string>;
  /** Initial working directory. Defaults to "/". Must be an absolute path. */
  cwd?: string;
  /** Filesystem paths to preopen as additional FDs beyond stdin/stdout/stderr. Defaults to ["/in", "/out", "/scratch", "/dev"]. */
  preopens?: string[];
  /** FD bindings. Defaults: stdin=/dev/null, stdout=/out/debug, stderr=/out/debug. */
  stdin?: string;
  stdout?: string;
  stderr?: string;
  /**
   * Additional numeric FDs to open at start, beyond stdin/stdout/stderr and preopen FDs.
   * Useful for programs that hardcode high-numbered FDs.
   * Keys are decimal integers ≥ 3 + preopens.length.
   */
  extra_fds?: Record<string, string>;
};

// NOTE: which program export to invoke is NOT a `wasi_setup` field — it's
// decided by the `modules` graph. The shim declares one import like
// `(import "program" "entry" (func ...))`; the contract author wires that
// import to whichever program export they want via the layer's `imports`
// map. WebAssembly cannot dispatch imports by string name at runtime.
```

Example for an AssemblyScript compile:

```jsonc
{
  "argv": ["asc", "/in/params", "-O3", "--outFile", "/out/record/default"],
  "env": { "ASC_OPTIMIZE_LEVEL": "3" },
  "cwd": "/scratch",
  "preopens": ["/in", "/out", "/scratch"],
  "stdin": "/dev/null",
  "stdout": "/out/debug",
  "stderr": "/out/debug"
}
```

If `wasi_setup` is absent on the contract block, the shim uses the defaults (no argv, no env, cwd=`/`, standard preopens, stdin/stdout/stderr as above).

## Memory Layout

Each module owns its own linear memory (per the updated [wasm-abi.md memory model](../protocol/wasm-abi.md#memory-model-stacking)). The shim declares `(memory (export "memory") ...)` and the program declares its own memory the same way. No data-section collision is possible because the data sections initialize *different* memories.

The shim imports the program's memory under a local name in its layer's `imports` map:

```jsonc
"wasi_shim": {
  "wasmHash": "...",
  "imports": {
    "scaffold_env.*": "base:*",
    "program_mem.memory": "program:memory",
    "_start": "program:_start"
  }
}
```

This lets the shim's WASM declare `(import "program_mem" "memory" (memory $prog_mem ...))` and access the program's memory via that index for cross-memory reads/writes.

**Cross-memory copies at the WASI boundary.** When the program calls `fd_write(prog_ptr, len)`, `prog_ptr` is an offset into the program's memory. The shim:
1. Reads `len` bytes from `(memory $prog_mem)` at offset `prog_ptr`.
2. Copies them into the shim's own memory at a freshly-allocated location.
3. Calls `scaffold_env.emit_output(shim_ptr, len)`. Scaffold reads from the shim's memory (the entry layer's memory).

The cost is one memcpy per WASI call, O(len). For compiler/interpreter-class workloads (large data, low call frequency) it's negligible; for printf-style chatter it's bounded.

The reverse path is the same: `request_body` writes into shim memory, shim copies to the program's destination buffer.

**No `--global-base` gymnastics.** Both modules use their toolchain defaults. The shim is normal Zig/Rust/whatever, the program is whatever it already was. No linker flags to coordinate.

### Language choice

Now that there's no data-section collision constraint, language choice is mostly developer preference:

- **Zig** (`wasm32-freestanding` target): ergonomic, small runtime, `comptime` keeps generated code lean.
- **Rust** (`wasm32-unknown-unknown` or `wasm32-wasi` with std stripped): also fine, more boilerplate for `no_std` builds.
- **TinyGo**: viable now (the issue was static-data globals, not the Go runtime per se). Probably overkill for this use case.

I'd start with Zig — the existing `src/worker/WasiImpl.ts` is the behavioural reference, and the port is mechanical. Switch if a real obstacle appears.

## Other Implementation Notes

1. **`max_memory_pages`.** Stacking shares one budget across the whole graph. A WASI program (e.g. a compiler) can want hundreds of MiB. The contract author sets `max_memory_pages` on their contract block; it applies to the shared memory across both shim and program. Picks a value that covers `program_data + program_heap + shim_offset (256 MiB) + shim_heap`.
2. **proc_exit propagation through WASM.** The standard WASI implementation strategy is to raise a special trap (`__wasi_proc_exit_exception` or similar) and catch it at the boundary. In our case, the boundary is `scaffold_env.reject`, which itself traps. So `proc_exit(n != 0)` → `scaffold_env.reject(...)` → trap → bubble out through the shim's `run` → caught by scaffold. `proc_exit(0)` must NOT trap — we want the shim's `run` to return normally. The shim implements this by storing an "exit requested" flag, then having `_start`'s WASM trap caught at the shim's call site via a sentinel that the shim recognises. In Zig this looks like calling the program through a JS forwarder that maps proc_exit(0) trap → setjmp-style flag.
3. **Reactor vs command modules.** Command modules export `_start`; reactor modules export `_initialize` and other named entries. v1 supports both via `wasi_setup.entry`. The shim invokes `entry` and treats normal return as success.
4. **`output_namespaces` discovery.** The shim doesn't know what namespaces the program will emit into until it emits. The contract author must declare `output_namespaces` on the contract block matching what the program emits. Mismatches are caught at verification time by the standard output-partition check. There's no automated discovery; documenting "list every namespace your program writes to" is sufficient.
5. **Path normalization.** `.` and `..` are normalized standardly; symlinks not supported; case-sensitive byte-level comparison. Trailing slashes ignored on regular files.

## Out of Scope for v1

- **JSON variants** (`/in/params.json`, walker-emitted views): defer. The byte interface covers it; programs can parse their own JSON. Reconsider once we have a concrete use case.
- **Sockets** (`sock_*`): `ENOTSUP`. Scaffold has no network surface a deterministic contract could touch.
- **Symlinks/hardlinks**: `ENOTSUP` everywhere. Trivially complicates the FS state.
- **Real `fd_filestat_set_times`**: returns success but doesn't store anything (the file is virtual).
- **`fork()` host call exposure**: the WASI shim doesn't expose scaffold's `fork()`. Forking is a scaffold-specific feature; WASI programs that need it should be written against a different shim or use a wrapper.
- **Claims**: WASI programs don't claim. The implicit "claim all" behaviour at end-of-contract handles non-claiming contracts.
- **Signing**: WASI programs don't sign. If a contract needs signing, it should use a different shim.
- **Live `walker`/`builder` paths**: v1 of the shim only implements `run`. The contract block's `base.imports` includes only `"run"`; calls to `walk_*` or `build_*` on a WASI-shimmed contract return ENOTSUP at the scaffold boundary.

## Testing Strategy

This shim is too large and too subtle to implement with confidence from a single set of hand-written tests. The plan stacks four independent sources of correctness signal:

### 1. Reference-implementation review

For each WASI call the shim implements, before shipping the call we read **all** the following independently and reconcile against our implementation:

- **WASI snapshot preview 1 spec** — `WebAssembly/WASI/legacy/preview1/docs.md`. Authoritative on signatures, errno values, and required behaviors.
- **`bjorn3/browser_wasi_shim`** (TypeScript, MIT) — closest implementation to our shape (browser, deterministic, virtual filesystem). Reference for edge cases like `path_open` flag interactions, `fd_readdir` cookie semantics.
- **`wasmtime/crates/wasi-common`** (Rust) — canonical engine reference. Reference for the "what would the most-used WASI engine do here?" question.
- **`wasi-libc`** — the C library the *program* is linked against. Reference for "what call patterns will our shim actually see?" Many WASI calls have multiple flag combinations that look equivalent in the spec but only certain ones come from wasi-libc in practice.
- Any other reasonably-mature WASI implementation we find (esp. Zig stdlib's `std.os.wasi` types).

Each call's PR notes which references were checked and any divergences, with rationale. Divergences are either documented as deliberate (e.g. determinism constraints) or fixed.

### 2. `wasi-testsuite` (WebAssembly/wasi-testsuite)

Pulled in as `tests/vendor/wasi-testsuite/` (git submodule). Harness lives at `tests/WasiTestsuite.test.ts`:
- Iterates the test programs (pre-compiled `.wasm` shipped in the repo).
- For each, reads the test's adapter JSON to extract argv/env/preopens.
- Constructs a Scaffold contract block (modules graph + `wasi_setup` from the adapter).
- Runs via the in-process transport.
- Captures `/out/debug` content + exit code; compares to expected.

Initial filter: skip tests under `nn-sock-*` (no socket support), tests requiring real wall-clock time, and any test requiring real signal delivery. Document the skip list with reasons. Aim for 80%+ of tests passing on first run.

### 3. Differential testing against wasmtime

For test programs we can also run locally with `wasmtime`, run the same binary both ways (matching argv/env/preopens), capture stdout/stderr/exit, diff. Catches divergences that the per-test expected-output comparison doesn't. Lives alongside the wasi-testsuite harness.

### 4. Contract-trace snapshot tests

Use [`tests/helpers/contractSnapshot.ts`](../../tests/helpers/contractSnapshot.ts) (general-purpose, not WASI-specific). Each per-WASI-call test:
- Specifies a contract-block records map (`modules` JSON + any contract-level records like `wasi_setup`).
- Specifies a `mock` of always-the-same `ContractEnv` responses (e.g. `mode`, `contract_hash`, `params`, `timestamp`).
- Specifies an ordered `sequence` of expected host calls with `expect` matchers and `respond` values.
- The helper runs the contract, asserts each host call matches the next sequence entry, captures the full trace (including cross-layer JS-forwarder hops via the `tracer` parameter on `loadModules`), and runs `assertSnapshot` on the rendered text.

First-run snapshot generation: `deno test --allow-all <file> -- --update`. Subsequent runs match the committed `.snap` file or fail with a diff. Rejection (`scaffold_env.reject`) is a first-class sequence step (`{ type: 'reject', expect: { reason: '...' } }`); unexpected rejections fail the test.

### 5. Real-world end-to-end

The dev demo's first language is AssemblyScript. Running `asc` (the AssemblyScript compiler, a WASI program) through the shim is the golden-path integration test. When `asc compile a one-liner` produces the same bytes as a local non-shim `asc compile a one-liner`, we know the shim works for compiler-class workloads.

## Source-tree Layout

The shim source lives in its own subdirectory under `src/contracts/wasi-shim/`, separate from scaffold core. It compiles to one `wasi-shim.wasm` blob. The internal modularity matters for testability and review, but the boundary is one WASM module — the WASI shim is just a module that users can use, not a scaffold protocol feature.

```
src/contracts/wasi-shim/
├── build.zig              — Zig build script; outputs wasi-shim.wasm
├── src/
│   ├── main.zig           — module entry; exports WASI ABI to program, run to scaffold
│   ├── abi/               — WASI snapshot preview 1 wire layer (no logic, just marshaling)
│   │   ├── types.zig      — errno, fdflags, oflags, rights — straight from std.os.wasi
│   │   ├── fd.zig         — fd_* functions; thin dispatch into vfs
│   │   ├── path.zig       — path_* functions; resolve path → vfs node, dispatch
│   │   ├── proc.zig       — proc_exit, proc_raise
│   │   ├── clock.zig      — clock_time_get, clock_res_get (deterministic)
│   │   ├── random.zig     — random_get (deterministic PRNG)
│   │   ├── args_env.zig   — args_get, environ_get
│   │   └── unsupported.zig — sock_*, path_symlink, etc. — return ENOTSUP
│   ├── vfs/               — virtual filesystem; no WASI-isms, no scaffold-isms
│   │   ├── vfs.zig        — node type, fd table, path resolver, dirent iter
│   │   ├── memfs.zig      — in-memory tree for /scratch
│   │   ├── devfs.zig      — /dev/null, /dev/zero, /dev/random, /dev/urandom
│   │   └── input_node.zig — read-only nodes whose bytes are produced by a callback
│   ├── scaffold/          — scaffold-specific wiring
│   │   ├── env.zig        — wraps scaffold_env.* imports (Zig-side ergonomic API)
│   │   ├── prog_mem.zig   — reads/writes program's memory via the imported memory
│   │   ├── setup.zig      — reads wasi_setup record, populates argv/env/preopens
│   │   └── paths.zig      — maps shim path prefixes (/in/body/..., /in/fetch/..., /out/record/..., etc.) onto scaffold calls
│   └── prng.zig           — counter-mode H(seed || counter) PRNG, shared by random_get + /dev/random
└── README.md              — how to build, test, contribute
```

Mapping to scaffold-side code:

| Path | Description |
|------|-------------|
| Future: `src/contracts/wasi-shim/` | Standalone Zig project producing `wasi-shim.wasm`. |
| Future: `src/contracts/wasi-shim/dist/wasi-shim.wasm` | Built artifact. Hash baked into a constant in `setup.ts`. |
| Future: `src/contracts/wasi-shim/setup.ts` | TS helper to construct a contract block: takes (program WASM hash, wasi_setup config) → modules graph + records. |
| Future: `tests/helpers/contractSnapshot.ts` | The general-purpose contract trace snapshot helper. |
| Future: `tests/vendor/wasi-testsuite/` | Vendored test suite (git submodule). |
| Future: `tests/WasiTestsuite.test.ts` | wasi-testsuite harness. |
| Future: `tests/WasiShim.test.ts` | Per-call unit tests and snapshot tests. |
| Existing: [`src/worker/WasiImpl.ts`](../../src/worker/WasiImpl.ts) | Reference TS implementation of the WASI surface (~1.5kloc). Behavioural source-of-truth for the Zig port. |
| Existing: [`src/worker/WasiConstants.ts`](../../src/worker/WasiConstants.ts) | Errno constants — Zig has these in `std.os.wasi`, but useful for cross-checking. |
| Existing: [`docs/protocol/wasm-abi.md#stacking`](../protocol/wasm-abi.md#stacking) | Stacking graph format the shim plugs into. |

## Cross-references

- Stacking graph format: [wasm-abi.md#stacking](../protocol/wasm-abi.md#stacking)
- HASH_CONTRACT (how the shim and program WASM blobs are discovered): [wasm-abi.md#stacking](../protocol/wasm-abi.md#stacking) and [HashContract.ts](../../src/contracts/HashContract.ts)
- DEV_DEMO_TASKS A4 (wasi-shim deliverable): [DEV_DEMO_TASKS.md](../../DEV_DEMO_TASKS.md)
