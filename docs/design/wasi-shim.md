# WASI Shim

> Status: implemented (v1). Spec for the in-stack shim that lets an unmodified WASI snapshot preview 1 program run as a Scaffold contract by mapping the WASI host surface onto `scaffold_env` via a virtual filesystem. Living in `src/contracts/wasi-shim/`; QuickJS boots end-to-end through it (`tests/WasiShimQuickJS.test.ts`) and the per-call snapshot suite (`tests/WasiShim.test.ts`) covers the 12-call MVP across 12 fixtures.

## Goal

Take a WASM module that was compiled against `wasi_snapshot_preview1` (e.g. by `clang --target=wasm32-wasi`, `rustc --target=wasm32-wasi`, or `tinygo -target=wasi`) and run it as a Scaffold contract without modification, by stacking it above a shim that translates WASI host calls into `scaffold_env` calls.

Most WASI programs targeted by this shim are **input/output-shaped** compute jobs: a compiler, an interpreter, a parser, a transformer. They consume scaffold-side inputs (`params`, `request_body`, `fetch`) as files, write scaffold-side outputs (`emit_output`) as files, and don't need scaffold-specific features (claims, sub-contract `put`, signatures). For those use cases, the WASI ↔ scaffold impedance match is excellent — both are byte-oriented synchronous request/response.

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
        "program._start": "program:_start",
        "program_mem.read_bytes":  "program:memory@read",
        "program_mem.write_bytes": "program:memory@write",
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

Each module owns its own memory (declared via `(memory (export "memory") ...)`). The program imports only the shim's WASI functions. No shared memory; no data-section collision.

**Cross-memory access via function imports, not multi-memory.** The shim needs to read pointers from the program's memory (e.g. the iovec arrays in `fd_write`) and write results back (e.g. the destination buffer in `args_get`). The naïve design uses a [WebAssembly multi-memory](https://github.com/WebAssembly/multi-memory) import — directly importing `program:memory` into the shim's memory index 1. That design is sound at the engine level (all major browsers support multi-memory) but **the Zig toolchain (0.16) does not emit `i32.load (memory $N)` for non-default memories**, and there's no `@wasmMemoryCopy(dstIdx, srcIdx, ...)` builtin. Forcing multi-memory through Zig would require either inline-WAT injection or post-processing the `.wasm` after compile, neither of which buy enough to justify the complexity.

Instead, the shim imports two thin accessor functions from a virtual `program_mem` namespace:

```
program_mem.read_bytes(prog_off: u32, shim_dst: u32, len: u32) -> ()
program_mem.write_bytes(prog_off: u32, shim_src: u32, len: u32) -> ()
```

The linker resolves these via the `@read` / `@write` accessor markers in the shim layer's `imports` map. Concretely:

```jsonc
"wasi_shim": {
  "imports": {
    "program_mem.read_bytes":  "program:memory@read",   // function import; binds to a memcpy closure
    "program_mem.write_bytes": "program:memory@write"
  }
}
```

`parseTargetRef` in [`src/plugins/wasm/WasmModules.ts`](../../src/plugins/wasm/WasmModules.ts) recognises the `@read` / `@write` suffix and produces a `TargetRef` with `accessor: 'read' | 'write'`. At instantiate time, `makeAccessorForwarder` (same file) synthesises a JS closure of signature `(prog_off, peer_off, len) => void` that runs `Uint8Array(dstMem.buffer, ...).set(Uint8Array(srcMem.buffer, ...))` between the source layer's primary memory and the named target memory. One JS↔WASM hop per cross-memory call, O(len) memcpy. For compute-shaped programs (compiler, interpreter, parser) the call frequency is low and the size per call is large, so the overhead is amortised; for printf-style chatter it's still bounded by one hop per `fd_write`.

Memories are resolved **lazily** at first call (looked up out of `memoryByLayerKey`), not bound at instantiate. This sidesteps a topo-sort cycle: the shim layer's accessor forwarders need to reference the program layer's memory, but the program layer hasn't been instantiated yet when the shim's import object is constructed. Lazy resolution lets both layers be instantiated in either order. Limitations carried by Phase E2: (1) the synth closure is fixed at signature `(i32, i32, i32) -> ()` — there is no kind-check at instantiate time, only at call time; (2) the "peer" memory is the source layer's *primary* memory (`memoryByLayerKey.get(srcLayerKey)`), so a layer that imports several memories with different roles can't disambiguate yet.

This keeps the Zig source idiomatic — no multi-memory builtins, no toolchain workarounds — at the cost of two extra imports. The shim WASM blob ends up smaller and easier to audit than the multi-memory variant would be. If a future shim needs raw multi-memory (e.g. for performance-critical interpreters), it can be added without breaking this design.

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
│   └── debug            — write bytes; routed to scaffold_env.debug (see /out/debug below), no record emitted
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

Writes to `/out/debug` are forwarded to a `scaffold_env.debug(ptr, len)` host import added in Phase D (live in `WasmHostBridge.ts` and threaded through all three transports). Inside the shim the route is `paths.appendDebug` → `env.debug` → host. The buffer is **line-buffered**: bytes accumulate in a `DebugNode` write buffer and a `flush()` fires on each `\n`; on FD close (including the implicit close at end-of-run via `autoCloseAll`) any trailing partial line is flushed. The debug stream **does not emit a scaffold output** — it's purely diagnostic. The host-side default (`WasmHostBridge.makeImports`) routes through `env.debug?.(...)` which the production `VerifyingEnv` / `GeneratingEnv` do not yet implement, so production writes are dropped silently (see TODO.md "logger wiring"); test envs and the snapshot helper capture the bytes for assertion. This is the canonical sink for `stderr` and for `printf` debugging from the program.

### `/dev/random` and `/dev/urandom`

Reads return bytes from a single deterministic PRNG seeded by `H(contract_hash || timestamp_ms_le8 || params)`. `scaffold_env` deliberately doesn't expose `block_hash` (we don't want to expand the protocol surface for one feature); the invocation triple is already per-execution-deterministic (every verifier sees the same contract_hash, the same wire-format timestamp, and the same params). The stream is infinite — programs may read as much as they want. Reads from both paths consume the same stream (no separate state between them), and `random_get` WASI calls also consume from this stream. Order of consumption is deterministic because program execution is deterministic.

The construction: a counter-mode PRNG outputting `H(seed || counter_le8)` per 32-byte block, where `counter` is a u64 advanced once per emitted block. The shim tracks `(seed, position)` as part of its state.

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

> Parser note: the shim ships a ~200-line JSON subset parser (objects, arrays, strings with standard escapes, plus `null` / `true` / `false` — no numbers, since `wasi_setup` doesn't need any). Zig's `std.json` isn't freestanding-friendly. The TS `setup.ts` helper produces canonical JSON with sorted keys.


```ts
type WasiSetup = {
  /** Program argv. Defaults to []. The shim does not synthesise a program name; if your program reads `argv[0]`, set it explicitly. */
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

Each module owns its own linear memory (per the updated [wasm-abi.md memory model](../protocol/wasm-abi.md#memory-model-stacking)). The shim declares `(memory (export "memory") ...)` and the program declares its own memory the same way. No data-section collision is possible because the data sections initialize *different* memories. Cross-memory access uses `program_mem.read_bytes` / `program_mem.write_bytes` (see [Architecture](#architecture)).

**Per-WASI-call flow.** When the program calls `fd_write(prog_iovs, iovs_len, ..., prog_nwritten)`:
1. The shim calls `program_mem.read_bytes(prog_iovs, shim_buf, iovs_len * 8)` to pull the iovec array into its own memory.
2. For each iovec entry `(prog_buf_ptr, buf_len)`, the shim calls `program_mem.read_bytes(prog_buf_ptr, shim_staging, buf_len)` to pull the actual bytes.
3. The shim calls `scaffold_env.emit_output(shim_staging, buf_len)` (or routes to debug, depending on the FD's path).
4. The shim writes the total bytes-written back: `program_mem.write_bytes(prog_nwritten, &shim_total, 4)`.

The reverse path (`fd_read`) is symmetric: scaffold writes into the shim's staging memory, the shim's `write_bytes` calls copy each chunk into the program's destination buffers.

**No `--global-base` gymnastics.** Both modules use their toolchain defaults. The shim is plain `wasm32-freestanding` Zig, the program is whatever it already was. No linker flags to coordinate.

### Memory layout caveats (shim-internal)

The shim's bump arena starts at a hardcoded offset, not at `__heap_base`. Layout per `build.zig`:

```
0..1 MiB        — Zig stack (grows down from __stack_pointer = 1 MiB, the wasm-ld default)
1 MiB..~1.1 MiB — .rodata + .data + BSS (incl. global state)
2 MiB..         — shim bump arena (`bump_ptr` in main.zig)
```

`exe.initial_memory = 64 * 64 KiB = 4 MiB`; the engine may grow if needed.

**Why 2 MiB and not 1 MiB.** Phase E2 caught a real bug here: the original `BUMP_START = 1 MiB` collided exactly with the start of `.rodata` (wasm-ld places `.rodata` at `__stack_pointer` by default). The first `alloc(...)` overwrote string literals like `"/dev/null"`, scrambling them and producing confusing `vfs.NotFound` errors during `populateFdTable`. Moving `BUMP_START` to 2 MiB clears stack + `.rodata` + `.data` + BSS with ~1 MiB of headroom over the largest BSS we can reasonably grow without restructuring `current_state`.

**Long-term cleanup** (TODO): pass `--export=__heap_base` to wasm-ld and read the linker-provided value at runtime instead of the hardcoded 2 MiB. That removes the headroom-vs-collision tradeoff entirely. Filed for follow-up; today's value is safe for the v1 surface.

### Language choice

Zig 0.16 (`wasm32-freestanding` target). Rationale:
- `comptime`, `inline fn`, `packed struct` keep the WASI marshalling code small and direct — the same surface in Rust requires more attribute soup or build flags.
- `ReleaseSmall` builds the minimum panic handler we measured at ~70 bytes per public function, vs. several hundred for default Rust.
- No runtime, no allocator pulled in unless we ask for it.
- Existing `src/worker/WasiImpl.ts` is the behavioural reference; the port is mechanical.

Rust on `wasm32-unknown-unknown` is the natural fallback if Zig hits a wall on something like `comptime` ergonomics; TinyGo is overkill.

## Minimum Viable WASI Surface

Per wasi-libc call-pattern analysis, a ~13-import surface covers ~95% of real programs (compilers, interpreters, parsers built against wasi-libc). Implement these first; everything else returns `ENOTSUP`. The first build batch lands the deterministic calls that don't need an FD table (clock, random, proc, args/env, sched); the second batch adds the FD/path layer.

| Call | Role | Source of reference |
|---|---|---|
| `proc_exit` | clean / failure termination | wasi-libc `_exit`, exit-from-main path |
| `fd_write` | stdout/stderr + scaffold outputs | always single ciovec from wasi-libc; multiple ciovecs only via `writev` |
| `fd_read` | stdin + input file reads | always single iovec from wasi-libc |
| `fd_close` | release FD slot | invalidate slot, push to free-list, don't free shared resources |
| `fd_seek` | file seeking | use full u64 offset math; do NOT downcast to JS number |
| `fd_fdstat_get` | file metadata | 24-byte struct: u8 filetype, u16 fdflags, 5-byte pad, u64 rights_base, u64 rights_inheriting |
| `fd_fdstat_set_flags` | append / nonblock toggle | only APPEND/DSYNC/NONBLOCK/RSYNC/SYNC reach the host |
| `fd_filestat_get` | size, dev/ino, type | required by `stat`/`fstat`; many programs read `dev`/`ino` |
| `fd_readdir` | directory walk | cookie starts at 0 (`DIRCOOKIE_START`); EOF when bytes-written < buf-size |
| `path_open` | open file/dir from preopen | wasi-libc requests near-max rights; gate by oflags+fdflags, not rights bitmap |
| `path_filestat_get` | stat without open | parallel to `fd_filestat_get` |
| `clock_time_get` | wall clock + monotonic | REALTIME = block timestamp ×10⁶; MONOTONIC = call counter (1 ns / call) |
| `random_get` | entropy | deterministic PRNG (`H(seed‖counter)`); shared stream with `/dev/random` |

After this batch lands and saghul/quickjs runs end-to-end, the second batch adds `args_get`/`args_sizes_get`/`environ_get`/`environ_sizes_get` (deterministic from `wasi_setup`) plus the `_*set_times`, `_*allocate`, and rights-related shims that real programs rarely call but `wasi-testsuite` exercises.

### Determinism corrections vs. WasiImpl.ts

The existing TS reference contains several non-determinism-or-correctness bugs that **must not** be ported verbatim. The Zig implementation reconciles these:

1. `clock_time_get(REALTIME)` — TS calls `Date.now()`; Zig uses scaffold's block timestamp ×10⁶.
2. `clock_time_get(MONOTONIC)` — TS calls `performance.now()`; Zig increments a per-call counter by 1 ns.
3. `random_get` — TS calls `crypto.getRandomValues()`; Zig uses the deterministic PRNG defined in [`/dev/random` and `/dev/urandom`](#devrandom-and-devurandom).
4. `fd_seek` / `fd_pread` / `fd_pwrite` — TS coerces i64 offsets to JS Number, losing precision above 2⁵³; Zig uses native u64/i64 arithmetic.
5. `poll_oneoff` — TS reads the subscription struct at incorrect offsets; Zig follows the spec layout (8 B userdata, 1 B tag, 7 B pad, 8 B u64 union).
6. iovec bounds — TS validates the iovec table pointer but not each element's `(ptr, len)`; Zig validates both.
7. `path_symlink` errno — TS returns `ENOSYS` uniformly; the design says `EROFS` outside `/scratch`, `ENOTSUP` inside. Zig follows the design.

### Reference-reconciled invariants

Decisions where the WASI spec leaves room and our two external references (`bjorn3/browser_wasi_shim`, `wasmtime/crates/wasi-common`) diverged. Picking these once, here, so individual call PRs don't re-litigate:

- **FD table** is a flat `ArrayList(?Fd)` plus a free-list of closed indices. Stdio = fds 0/1/2, preopens start at fd 3.
- **`fd_close`** sets the slot to `null` and pushes to the free-list; it does not free shared resources (stdio sinks, `/dev/random`).
- **`fd_prestat_dir_name`** writes the path bytes exactly as configured — no trailing NUL, no trailing slash. Returns `ENAMETOOLONG` if the buffer is short rather than silently truncating (matches `bjorn3/browser_wasi_shim`; diverges from wasmtime which truncates).
- **Default FD method** for unimplemented capabilities returns `ENOTSUP` (clearer debugging signal than `EBADF`). Type-mismatches still return the typed errno (`ENOTDIR`, `EISDIR`).
- **Rights** are tracked per-fd as a `{read, write, …}` flag set and **enforced only at the shim** -- OS-level enforcement is N/A since the shim is the FS. The Phase C clamp model (`abi/path.zig:finishOpen`): the requested `rights_base` / `rights_inheriting` are masked against the **node's supported rights** (derived from `vfs.Node.kind` — `/in/*` → READ-only, `/out/*` → WRITE-only, `/scratch/*` → READ+WRITE+SEEK, devfs nodes per their kind). The clamp is silent — a request for FD_WRITE on `/in/foo` succeeds and returns an FD with FD_WRITE cleared; wasi-libc requests near-max rights as a default and the program never sees a synthetic `ENOTCAPABLE` from `path_open`. Post-clamp, per-call rights gates produce the right errno synchronously: missing READ → `EBADF` from `fd_read`; missing WRITE → `EBADF` from `fd_write`. No `EACCES` mapping.
- **Path normalisation**: absolute paths in `path_*` calls relative to a dirfd → `ENOTCAPABLE`; `..` that escapes the preopen → `ENOTCAPABLE`; trailing slash preserved as an `expects_directory` flag and passed to `path_open` (open on a regular file with trailing slash → `ENOTDIR`).
- **Memory/pointer errors trap, don't errno**. Out-of-bounds guest pointer or misaligned argument area → trap from the host import. This matches wasmtime's wiggle invariant and what real engines do.
- **Errno numeric values**: take them from `wasi_defs.ts` in `bjorn3/browser_wasi_shim` (which matches the spec). The 12 we care about most: `EBADF=8`, `EEXIST=20`, `EINVAL=28`, `EISDIR=31`, `ENAMETOOLONG=37`, `ENOENT=44`, `ENOTDIR=54`, `ENOTSUP=58`, `EPERM=63`, `EPIPE=64`, `ENOTCAPABLE=76`, `EAGAIN=6`.

## Other Implementation Notes

1. **`max_memory_pages`.** Stacking shares one budget across the whole graph. A WASI program (e.g. a compiler) can want hundreds of MiB. The contract author sets `max_memory_pages` on their contract block; it applies to the shared memory across both shim and program. Picks a value that covers `program_data + program_heap + shim_offset (256 MiB) + shim_heap`.
2. **proc_exit propagation through WASM, and the `EXIT_ZERO_REASON` magic string.** `proc_exit(n != 0)` calls `scaffold_env.reject("WASI proc_exit: <n>")` which traps; the rejection surfaces at scaffold as a `ContractRejection` with that reason. `proc_exit(0)` must NOT surface as a rejection — the shim's `run` should return normally. We use the same `reject` machinery but with a sentinel reason string:

   ```
   EXIT_ZERO_REASON = "__SCAFFOLD_WASI_EXIT_ZERO__"
   ```

   This sentinel is **load-bearing across the language boundary** and must stay byte-equal in three places:
   - **Zig:** [`src/contracts/wasi-shim/src/abi/proc.zig`](../../src/contracts/wasi-shim/src/abi/proc.zig) declares the constant; `proc_exit(0)` calls `env.reject(EXIT_ZERO_REASON)`.
   - **TypeScript (setup):** [`src/contracts/wasi-shim/setup.ts`](../../src/contracts/wasi-shim/setup.ts) re-exports it; `withExitRecognition()` (the run-wrapper) catches `ContractRejection` with this exact `.message` and converts to a clean return.
   - **Test helper:** [`tests/helpers/contractSnapshot.ts`](../../tests/helpers/contractSnapshot.ts) imports the same constant and treats this rejection reason as a clean exit when rendering the trace.

   Any other rejection reason propagates as a real rejection. If you change the string, change all three.
3. **Reactor vs command modules.** Command modules export `_start`; reactor modules export `_initialize` and other named entries. v1 supports both via `wasi_setup.entry`. The shim invokes `entry` and treats normal return as success.
4. **`output_namespaces` discovery.** The shim doesn't know what namespaces the program will emit into until it emits. The contract author must declare `output_namespaces` on the contract block matching what the program emits. Mismatches are caught at verification time by the standard output-partition check. There's no automated discovery; documenting "list every namespace your program writes to" is sufficient.
5. **Path normalization.** `.` and `..` are normalized standardly; symlinks not supported; case-sensitive byte-level comparison. Trailing slashes ignored on regular files.

## Out of Scope for v1

- **JSON variants** (`/in/params.json`, walker-emitted views): defer. The byte interface covers it; programs can parse their own JSON. Reconsider once we have a concrete use case.
- **Sockets** (`sock_*`): `ENOTSUP`. Scaffold has no network surface a deterministic contract could touch.
- **Symlinks/hardlinks**: `ENOTSUP` everywhere. Trivially complicates the FS state.
- **Real `fd_filestat_set_times`**: returns success but doesn't store anything (the file is virtual).
- **`put()` host call exposure**: the WASI shim doesn't expose scaffold's `put()`. Spawning sub-contracts is a scaffold-specific feature; WASI programs that need it should be written against a different shim or use a wrapper.
- **Claims**: WASI programs don't claim. The implicit "claim all" behaviour at end-of-contract handles non-claiming contracts.
- **Signing**: WASI programs don't sign. If a contract needs signing, it should use a different shim.
- **Live `walker`/`builder` paths**: v1 of the shim only implements `run`. The contract block's `base.imports` includes only `"run"`; calls to `walk_*` or `build_*` on a WASI-shimmed contract return ENOTSUP at the scaffold boundary.

## Testing Strategy

The v1 shim ships with two stacked sources of correctness signal: contract-trace snapshot tests for every MVP call shape, and a QuickJS end-to-end shakedown that exercises the whole stack against a real WASI program. Reference review and the wasi-testsuite/differential-testing aspirations remain TODOs (see below).

### 1. Contract-trace snapshot tests (live)

[`tests/WasiShim.test.ts`](../../tests/WasiShim.test.ts) runs 12 fixtures (`tests/fixtures/wasm/wasi/wasi_*.wat` → `.wasm`) covering the 12-call MVP plus argv/env. Each fixture:
- Composes a contract block via [`src/contracts/wasi-shim/setup.ts`](../../src/contracts/wasi-shim/setup.ts) (modules graph + `wasi_setup` + `output_namespaces`).
- Drives it through [`tests/helpers/contractSnapshot.ts`](../../tests/helpers/contractSnapshot.ts) (general-purpose, not WASI-specific): a `mock` of `ContractEnv` responses (`mode`, `contract_hash`, `params`, `timestamp`, `request_body`, `fetch`, `contract_metadata`) plus an ordered `sequence` of expected host calls with `expect` matchers and `respond` values.
- The helper captures the full trace including cross-layer JS-forwarder hops (via the `tracer` parameter on `loadModules`) and runs `assertSnapshot` on the rendered text. Rejection (`scaffold_env.reject`) is a first-class sequence step; the `EXIT_ZERO_REASON` sentinel is recognised as a clean exit.

First-run snapshot generation: `deno test --allow-all tests/WasiShim.test.ts -- --update`. Subsequent runs match the committed `tests/__snapshots__/WasiShim.test.ts.snap` or fail with a diff.

Run them via the dedicated task: `deno task test:wasi` (which also rebuilds the shim).

The 12 fixtures: `wasi_args`, `wasi_clock_monotonic`, `wasi_clock_realtime`, `wasi_environ`, `wasi_fd_read_params`, `wasi_fd_readdir`, `wasi_fd_write_record`, `wasi_fd_write_stdout`, `wasi_path_open_then_read`, `wasi_proc_exit_fail`, `wasi_proc_exit_ok`, `wasi_random`.

### 2. QuickJS shakedown (live)

[`tests/WasiShimQuickJS.test.ts`](../../tests/WasiShimQuickJS.test.ts) boots an unmodified `saghul/quickjs` preview1 build through the shim. The QuickJS WASM is fetched and cached locally via `deno task vendor:quickjs` ([`scripts/vendor_quickjs.ts`](../../scripts/vendor_quickjs.ts)); the test snapshots the host-call trace (`tests/__snapshots__/WasiShimQuickJS.test.ts.snap`) and asserts the program reaches `proc_exit(0)`. This is the proof the shim composes correctly: stdin → eval → stdout exercises `args_get`/`args_sizes_get`, `fd_read` on fd 0, `fd_write` on fds 1/2, `proc_exit`, `clock_time_get` (via JS `Date`), `random_get` (via JS `Math.random`).

### 3. Native Zig unit tests (live)

`zig build test` (or via the inline build step in `deno task build:wasi-shim`'s sibling `zig build test`) runs the pure-logic modules (`vfs`, `prng`, `state`, `json`, path normalisation) on the host. Rooted at [`src/contracts/wasi-shim/src/tests.zig`](../../src/contracts/wasi-shim/src/tests.zig).

### TODO — reference review, wasi-testsuite, differential testing

The original design called for additional layers that have not landed. They remain on the post-v1 roadmap:

- **Per-call reference review.** Cross-checking each call against the WASI snapshot preview 1 spec, `bjorn3/browser_wasi_shim`, `wasmtime/crates/wasi-common`, and `wasi-libc`. Phase A produced [`docs/design/wasi-shim-decisions.md`](./wasi-shim-decisions.md) doing exactly this for the 12-call MVP; extending the format to the long tail of `ENOTSUP`-stubbed calls is future work.
- **`wasi-testsuite` integration.** Vendoring `WebAssembly/wasi-testsuite` as `tests/vendor/wasi-testsuite/` and running its programs through the shim. Filter list TBD; deferred to post-v1.
- **Differential testing against `wasmtime`.** Run each test program both through the shim and through `wasmtime` locally; diff stdout/stderr/exit. Deferred to post-v1.
- **Larger real-world programs.** PHP (`php-cgi-8.2.6-slim.wasm`), Ruby (`ruby-3.2.2-slim.wasm`), and especially CPython (`python-3.12.0.wasm`) are the graduation targets. CPython's import cache compares inodes, so it requires the inode upgrade tracked in `TODO.md` ("Wyhash inodes for `fd_filestat_get`/`path_filestat_get` before CPython graduation"). **SpiderMonkey** is preview2-only and not a viable preview1 target. **SQLite CLI** lacks a maintained standalone preview1 build; defer until one appears.

## Source-tree Layout

The shim source lives in its own subdirectory under `src/contracts/wasi-shim/`, separate from scaffold core. It compiles to one `wasi-shim.wasm` blob. The internal modularity matters for testability and review, but the boundary is one WASM module — the WASI shim is just a module that users can use, not a scaffold protocol feature.

```
src/contracts/wasi-shim/
├── build.zig              — Zig build script; outputs dist/wasi-shim.wasm
├── dist/
│   └── wasi-shim.wasm     — built artifact; hash discovered by setup.ts at runtime
├── setup.ts               — TS helper that composes a Scaffold contract block
├── README.md              — quick-start; links to this design doc
└── src/
    ├── main.zig           — module entry; exports WASI ABI to program, run to scaffold
    ├── state.zig          — per-run mutable state (argv/env/preopens, FD table, PRNG counters)
    ├── prng.zig           — counter-mode H(seed || counter) PRNG, shared by random_get + /dev/random
    ├── json.zig           — freestanding JSON subset parser (objects/strings/bool/null; no numbers)
    ├── tests.zig          — root for `zig build test` (native, host-target unit tests)
    ├── abi/               — WASI snapshot preview 1 wire layer (marshaling, light logic)
    │   ├── types.zig      — errno, fdflags, oflags, rights, packed wire structs (Iovec, Fdstat, Filestat)
    │   ├── fd.zig         — fd_* dispatchers + serialisers (Fdstat/Filestat/Dirent)
    │   ├── path.zig       — path_* dispatchers; normalisation, splitParentLeaf, finishOpen with rights clamp
    │   ├── proc.zig       — proc_exit (EXIT_ZERO_REASON sentinel), proc_raise
    │   ├── clock.zig      — clock_time_get, clock_res_get (deterministic)
    │   ├── random.zig     — random_get (deterministic PRNG)
    │   ├── args_env.zig   — args_get, args_sizes_get, environ_get, environ_sizes_get
    │   └── unsupported.zig — sock_*, path_symlink, etc. — return ENOTSUP / EROFS
    ├── vfs/               — virtual filesystem; no WASI-isms, no scaffold-isms
    │   ├── vfs.zig        — Node, NodeKind, FdTable, path resolver, error set
    │   ├── memfs.zig      — in-memory tree for /scratch (bump-allocated, dropped on exit)
    │   ├── devfs.zig      — /dev/null, /dev/zero, /dev/random, /dev/urandom
    │   └── input_node.zig — read-only nodes whose bytes are produced by a callback
    └── scaffold/          — scaffold-specific wiring
        ├── env.zig        — wraps scaffold_env.* imports (Zig-side ergonomic API)
        ├── prog_mem.zig   — reads/writes program's memory via program_mem.{read,write}_bytes
        ├── setup.zig      — reads wasi_setup record, populates argv/env/preopens, builds initial FD table
        ├── paths.zig      — maps shim path prefixes (/in/..., /out/...) onto scaffold calls; OutputLeaf, RecordAccumulator, DebugNode
        └── paths_codec.zig — hex/decimal encoding helpers shared by paths.zig
```

Mapping to scaffold-side code:

| Path | Description |
|------|-------------|
| [`src/contracts/wasi-shim/`](../../src/contracts/wasi-shim/) | Standalone Zig project producing `wasi-shim.wasm`. |
| [`src/contracts/wasi-shim/dist/wasi-shim.wasm`](../../src/contracts/wasi-shim/dist/wasi-shim.wasm) | Built artifact; hash discovered by `setup.ts` at runtime via `Hash.digest`. |
| [`src/contracts/wasi-shim/setup.ts`](../../src/contracts/wasi-shim/setup.ts) | TS helper: `(shimBytes, programBytes, wasi_setup) → { records, blobs }` ready for `assertContractTraceSnapshot` / a publisher. Also exports `EXIT_ZERO_REASON` and `withExitRecognition`. |
| [`tests/helpers/contractSnapshot.ts`](../../tests/helpers/contractSnapshot.ts) | General-purpose contract-trace snapshot helper. WASI-aware to the extent that it recognises `EXIT_ZERO_REASON`. |
| [`tests/WasiShim.test.ts`](../../tests/WasiShim.test.ts) | 12-fixture per-call snapshot suite. |
| [`tests/WasiShimQuickJS.test.ts`](../../tests/WasiShimQuickJS.test.ts) | QuickJS end-to-end shakedown. |
| [`tests/WasiShimSetup.test.ts`](../../tests/WasiShimSetup.test.ts) | Unit tests for `setup.ts` (default omission, output_namespaces encoding, etc.). |
| [`scripts/vendor_quickjs.ts`](../../scripts/vendor_quickjs.ts) | Vendoring script invoked via `deno task vendor:quickjs`. |
| [`src/worker/WasiImpl.ts`](../../src/worker/WasiImpl.ts) | Reference TS implementation of the WASI surface (~1.5kloc). Behavioural source-of-truth that informed the Zig port; not invoked at runtime by the shim path. |
| [`src/worker/WasiConstants.ts`](../../src/worker/WasiConstants.ts) | Errno constants — Zig has these in `std.os.wasi`, but useful for cross-checking. |
| [`docs/protocol/wasm-abi.md#stacking`](../protocol/wasm-abi.md#stacking) | Stacking graph format the shim plugs into. |
| **Not landed:** `tests/vendor/wasi-testsuite/`, `tests/WasiTestsuite.test.ts` | wasi-testsuite vendoring + harness; see Testing Strategy TODO. |

## Cross-references

- Stacking graph format: [wasm-abi.md#stacking](../protocol/wasm-abi.md#stacking)
- HASH_CONTRACT (how the shim and program WASM blobs are discovered): [wasm-abi.md#stacking](../protocol/wasm-abi.md#stacking) and [HashContract.ts](../../src/contracts/HashContract.ts)
- DEV_DEMO_TASKS A4 (wasi-shim deliverable): [DEV_DEMO_TASKS.md](../../DEV_DEMO_TASKS.md)
