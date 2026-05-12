# WASI Shim — Build Gap Audit

> Snapshot of the gap between the design's "Source-tree Layout" and what is
> actually on disk in `src/contracts/wasi-shim/src/`. Use this to plan the
> foundation-module landings before any of the 12 MVP ABI calls are wired up.

## Source-tree status

The design lists 14 Zig source files. Only `main.zig` exists, and it is a
skeleton that imports seven sibling modules that have not been created yet.
None of `abi/`, `vfs/`, `scaffold/`, or `prng.zig` exist on disk.

| Module | Status | Notes |
|---|---|---|
| `src/main.zig` | **partial (skeleton only)** | Compiles only as a syntax tree; the `@import` lines fail because every sibling is missing. References: `abi/types.zig`, `abi/proc.zig`, `abi/clock.zig`, `abi/random.zig`, `abi/args_env.zig`, `abi/unsupported.zig`, `state.zig`. Has the bump allocator, all 38 `export fn` stubs (most call `unsupported.notsup()`), `panic` handler routing through `scaffold_env.reject`. Calls `state.init` from `run` with `.timestamp_ms` and `.contract_hash_packed` only — the `state.InitArgs` shape needs to be wider (argv/env/cwd/preopens), so either `main.zig` will grow more setup logic or `state.init` will own pulling more from `scaffold_env`. |
| `src/state.zig` | **missing** | Per-run mutable state: timestamp, contract hash, monotonic counter, prng counter, argv/env/cwd, preopens, FD table. Reset at the start of every `run`. Holds the live `vfs.FdTable`. See API below. |
| `src/prng.zig` | **missing** | Counter-mode `H(seed ‖ counter)` PRNG; seed = `H(block_hash ‖ contract_hash)`. Shared between `random_get` and `/dev/random`. The shim has no `block_hash` import today — only `contract_hash` — so seeding needs a design clarification (use `H(contract_hash)` alone? add a `block_hash` scaffold_env import? rely on `timestamp ‖ contract_hash`?). **Flag for orchestrator.** |
| `src/abi/types.zig` | **missing** | Errno/fdflags/oflags/rights/filetype/clockid/whence/preopentype/eventtype enums. Zig 0.16 ships these in `std.os.wasi`; this file should re-export them under `abi.Errno`, `abi.Fdflags`, etc. so call sites stay short. `main.zig` already references `abi.Errno.SUCCESS`. |
| `src/abi/proc.zig` | **missing** | `proc_exit` (uses the `__SCAFFOLD_WASI_EXIT_ZERO__` magic reason from §2 of "Other Implementation Notes" so a clean exit doesn't surface as a rejection), `proc_raise`. Imports `reject` from `main.zig` (or from `scaffold/env.zig` once that lands). |
| `src/abi/clock.zig` | **missing** | `clock_time_get` / `clock_res_get`. `REALTIME = state.timestamp_ms × 10^6 ns`; `MONOTONIC` / `PROCESS_CPUTIME` / `THREAD_CPUTIME` advance `state.monotonic_counter` by 1 ns and return it. `clock_res_get` returns constant `1`. Writes the u64 result through `program_mem.write_bytes` (this is into the program's memory, not the shim's). |
| `src/abi/random.zig` | **missing** | `random_get` — pulls bytes from `prng.zig` and pushes them to the program via `program_mem.write_bytes(buf, shim_staging, len)`. Needs a small scratch staging area in shim memory (a fixed `[4096]u8` is fine; loop for larger reads). |
| `src/abi/args_env.zig` | **missing** | `args_get` / `args_sizes_get` / `environ_get` / `environ_sizes_get`. Reads from `state.argv` / `state.env`. Encodes `key=value\0` for env, `arg\0` for argv. All four destination buffers live in **program memory**, so writes go through `program_mem.write_bytes`. Total-size precomputation matches `WasiImpl.wasi_args_sizes_get` / `wasi_environ_sizes_get`. |
| `src/abi/unsupported.zig` | **missing** | One function: `pub inline fn notsup() i32 { return @intFromEnum(abi.Errno.NOTSUP); }`. The home for stubs that genuinely return `ENOTSUP` post-MVP (e.g. `sock_*`, `path_link`, `path_readlink`). The shape can be a single helper plus per-export wrappers as call sites need richer errno (e.g. `EROFS` for `path_symlink` outside `/scratch`). |
| `src/abi/fd.zig` | **missing (batch 2)** | `fd_*` dispatchers. Each looks up `state.fd_table.get(fd)` → `vfs.Node` and calls into vfs. Marshals iovecs via `program_mem.read_bytes`. Owns the `fd_write` → debug-or-emit-output routing. |
| `src/abi/path.zig` | **missing (batch 2)** | `path_*` dispatchers. Reads the path bytes from program memory, calls `vfs.resolve(state.fd_table.get(dirfd), path_bytes, oflags)`, then dispatches to vfs. |
| `src/vfs/vfs.zig` | **missing (batch 2)** | The core vfs vocabulary — `Node`, `NodeKind`, `FdEntry`, `FdTable`, `PathResolver`. Must be **WASI-agnostic** (no errno) and **scaffold-agnostic** (no `scaffold_env` imports). Returns its own error set; the abi layer translates to errno. |
| `src/vfs/memfs.zig` | **missing (batch 2)** | In-memory tree backing `/scratch`. Bump-buffer-friendly: a `Node` arena keyed by inode index, `Children = ArrayList(struct{ name:[]u8, inode:u32 })`. No allocator beyond the per-run bump arena that lives in `state`. |
| `src/vfs/devfs.zig` | **missing (batch 2)** | `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`. Pure functions over the prng (`/dev/random` and `/dev/urandom` share the prng stream). |
| `src/vfs/input_node.zig` | **missing (batch 2)** | Read-only nodes whose bytes come from a callback. Used for `/in/params`, `/in/timestamp`, `/in/contract_hash`, `/in/mode`, plus the dynamic `/in/body/.../...`, `/in/fetch/.../...`, `/in/contract_metadata/.../...`. The callback closes over a `scaffold/paths.zig` resolver. |
| `src/scaffold/env.zig` | **missing** | Zig-side ergonomic wrapper around the `scaffold_env.*` imports declared in `main.zig`. Today every WASI handler would have to know about packed `i64` ptr+len returns — this module hides that. See API below. |
| `src/scaffold/prog_mem.zig` | **missing** | Thin Zig wrappers over `program_mem.read_bytes` / `program_mem.write_bytes`. Adds typed helpers for `readU32`, `writeU32`, `readU64`, `writeU64`, `readSlice` (into a caller-provided buffer), `writeSlice`. Centralises the cast soup so call sites read clean. |
| `src/scaffold/setup.zig` | **missing** | Reads the `wasi_setup` JSON record via `scaffold_env.contract_metadata`, parses it (handwritten — `std.json` does not compile freestanding without an allocator; either ship a tiny purpose-built JSON parser or have the contract publisher pre-encode `wasi_setup` in a wire format the shim can decode without JSON). **Flag for orchestrator.** Populates `state.argv`, `state.env`, `state.cwd`, `state.preopens`, and the initial FD table (stdio + preopens + extra_fds). |
| `src/scaffold/paths.zig` | **missing (batch 2)** | Maps `/in/body/0x.../...`, `/in/fetch/0x.../.../...`, `/in/contract_metadata/0x.../.../`, `/out/record/...`, `/out/output/0x.../.../<amount>`, `/out/debug` onto `scaffold_env.{request_body, fetch, contract_metadata, emit_output, reject}` calls. Owns the hex parsing (`0x` discriminator), the params-encoding rule, the amount-decimal parse. |
| `build.zig` | **OK** | Single `addExecutable` with `entry = .disabled`, `rdynamic = true`, target `wasm32-freestanding`, default optimize `ReleaseSmall`, output redirected to `dist/wasi-shim.wasm`. Matches the design. |
| `dist/wasi-shim.wasm` | **missing** | Build artefact. Won't exist until the foundation modules compile. |
| `setup.ts` | **missing** | The TS contract-block builder mentioned in "Mapping to scaffold-side code". Out of scope for this audit (lives outside `src/contracts/wasi-shim/src/`), but called out so the orchestrator remembers it. |
| `README.md` | **missing** | Per design layout. Low priority. |

## Foundation modules — priority order

These must land before any of the 12 MVP ABI calls (clock/random/proc/args_env
batch + fd/path batch) can be implemented. Listed in the order they should be
written; later modules import earlier ones.

### 1. `src/abi/types.zig` — WASI enums

Zero dependencies. Re-exports / mirrors `std.os.wasi`. Everything else in the
shim references `abi.Errno`, so this is the absolute first thing.

```zig
// src/abi/types.zig — WASI snapshot preview 1 enums + packed structs.
// Mirrors `std.os.wasi`; we re-export under shorter names so call sites
// stay readable.

pub const Errno = enum(u16) {
    SUCCESS = 0,
    BADF = 8,
    EXIST = 20,
    INVAL = 28,
    ISDIR = 31,
    NAMETOOLONG = 37,
    NOENT = 44,
    NOTDIR = 54,
    NOTSUP = 58,
    PERM = 63,
    PIPE = 64,
    NOTCAPABLE = 76,
    AGAIN = 6,
    ROFS = 69,
    // ... full list per wasi_defs.ts; values authoritative.
};

pub const ClockId = enum(u32) {
    REALTIME = 0,
    MONOTONIC = 1,
    PROCESS_CPUTIME_ID = 2,
    THREAD_CPUTIME_ID = 3,
};

pub const Whence = enum(u8) { SET = 0, CUR = 1, END = 2 };

pub const Filetype = enum(u8) {
    UNKNOWN = 0,
    BLOCK_DEVICE = 1,
    CHARACTER_DEVICE = 2,
    DIRECTORY = 3,
    REGULAR_FILE = 4,
    SOCKET_DGRAM = 5,
    SOCKET_STREAM = 6,
    SYMBOLIC_LINK = 7,
};

pub const Fdflags = packed struct(u16) {
    APPEND: bool = false,
    DSYNC: bool = false,
    NONBLOCK: bool = false,
    RSYNC: bool = false,
    SYNC: bool = false,
    _pad: u11 = 0,
};

pub const Oflags = packed struct(u16) {
    CREAT: bool = false,
    DIRECTORY: bool = false,
    EXCL: bool = false,
    TRUNC: bool = false,
    _pad: u12 = 0,
};

pub const Rights = u64; // bitfield; constants live as `pub const RIGHT_FD_READ: Rights = ...`.

pub const Preopentype = enum(u8) { DIR = 0 };

pub const Iovec = extern struct { buf: u32, buf_len: u32 }; // wasm32 layout
pub const Ciovec = extern struct { buf: u32, buf_len: u32 };

// Convenience: convert any error of the local `VfsError` set to an Errno.
pub fn errnoFromVfs(err: anytype) Errno;
```

### 2. `src/abi/unsupported.zig` — errno helpers

Trivial; needed because `main.zig` already calls `unsupported.notsup()`.

```zig
// src/abi/unsupported.zig — homes the "return ENOTSUP" path so call sites
// stay readable. Also hosts the design's not-supported-but-has-a-typed-errno
// stubs (e.g. EROFS for path_symlink outside /scratch).

const abi = @import("types.zig");

pub inline fn notsup() i32 {
    return @intFromEnum(abi.Errno.NOTSUP);
}

pub inline fn errno(e: abi.Errno) i32 {
    return @intFromEnum(e);
}
```

### 3. `src/scaffold/prog_mem.zig` — cross-memory helpers

The whole shim talks to program memory through this module. Without it,
every call site has to hand-roll `read_bytes` casts and a staging buffer.

```zig
// src/scaffold/prog_mem.zig — typed wrappers over the `program_mem.*`
// import functions. The shim never touches the program's memory directly;
// every read/write goes through here.

const main = @import("../main.zig");

/// Read `dst.len` bytes from program offset `src` into the shim-side slice.
/// Caller owns `dst`. No bounds check — the host import traps on OOB
/// (matches wasmtime/wiggle invariant from the design's reference list).
pub fn readSlice(src: u32, dst: []u8) void {
    main.read_bytes(@intCast(src), @intCast(@intFromPtr(dst.ptr)), @intCast(dst.len));
}

pub fn writeSlice(dst: u32, src: []const u8) void {
    main.write_bytes(@intCast(dst), @intCast(@intFromPtr(src.ptr)), @intCast(src.len));
}

pub fn readU32(src: u32) u32 {
    var buf: [4]u8 = undefined;
    readSlice(src, &buf);
    return std.mem.readInt(u32, &buf, .little);
}

pub fn writeU32(dst: u32, value: u32) void {
    var buf: [4]u8 = undefined;
    std.mem.writeInt(u32, &buf, value, .little);
    writeSlice(dst, &buf);
}

pub fn readU64(src: u32) u64; // analogous
pub fn writeU64(dst: u32, value: u64) void;

/// Read an iovec/ciovec table from program memory into a caller-provided
/// shim-side array. Each entry is 8 bytes (u32 buf, u32 len).
pub fn readIovecs(src: u32, out: []abi.Iovec) void;
```

### 4. `src/scaffold/env.zig` — scaffold_env wrapper

Wraps the `extern fn` declarations in `main.zig` to hide the packed `i64` ptr+len return convention behind Zig slices.

```zig
// src/scaffold/env.zig — Zig-side wrapper around the scaffold_env.* imports.
// `i64` returns from scaffold are `(ptr << 32) | len`, where ptr/len point
// into the shim's own memory (the scaffold runtime stages bytes through
// `alloc`).

const main = @import("../main.zig");

pub fn mode() u8 {
    return @intCast(main.mode());
}

pub fn timestamp() u64 {
    return @intCast(main.timestamp());
}

/// Returns a slice into the shim's memory. The slice is only valid until
/// the next `alloc()` call (the bump allocator may overwrite it).
pub fn params() []const u8 {
    return unpack(main.params());
}

pub fn contractHash() [32]u8 {
    const slice = unpack(main.contract_hash());
    var out: [32]u8 = undefined;
    @memcpy(&out, slice[0..32]);
    return out;
}

pub fn contractMetadata(verifier: []const u8) []const u8 {
    return unpack(main.contract_metadata(
        @intCast(@intFromPtr(verifier.ptr)),
        @intCast(verifier.len),
    ));
}

pub fn requestBody(verifier: []const u8) []const u8;
pub fn fetch(verifier: []const u8, key: []const u8) []const u8;

pub fn emitOutput(bytes: []const u8) void {
    main.emit_output(@intCast(@intFromPtr(bytes.ptr)), @intCast(bytes.len));
}

pub fn reject(reason: []const u8) noreturn {
    main.reject(@intCast(@intFromPtr(reason.ptr)), @intCast(reason.len));
    unreachable;
}

fn unpack(packed_val: i64) []const u8 {
    const u: u64 = @bitCast(packed_val);
    const ptr: u32 = @intCast(u >> 32);
    const len: u32 = @intCast(u & 0xFFFF_FFFF);
    return @as([*]u8, @ptrFromInt(ptr))[0..len];
}
```

### 5. `src/prng.zig` — deterministic PRNG

Needed by `random_get` (batch 1) and `/dev/random` (batch 2). Single counter
shared across both consumers via `state.prng_counter`.

```zig
// src/prng.zig — counter-mode H(seed || counter) PRNG.
// Seed lives in state; this module is pure functions over (seed, counter).
// Output is 32-byte blocks; callers slice to length.

/// Fill `out` with deterministic bytes. Advances `counter` by
/// `ceil(out.len / 32)`. The same `(seed, counter)` always produces the
/// same bytes — counter must monotonically advance across all consumers.
pub fn fill(seed: [32]u8, counter: *u64, out: []u8) void;

/// Compute SHA-256 of (seed || counter_le_u64). Used internally by `fill`.
fn block(seed: [32]u8, counter: u64) [32]u8;
```

> **Open question for orchestrator:** the design says the PRNG is seeded by
> `H(block_hash ‖ contract_hash)`, but the shim only imports `contract_hash`
> from `scaffold_env`, not `block_hash`. Either add a `block_hash` import to
> `WasmHostBridge.ts` or change the seed to derive from
> `H(contract_hash ‖ timestamp)`. Picking the latter for now would unblock
> implementation; flagging because it's a design-doc divergence.

### 6. `src/state.zig` — per-run state

The hub everything else hangs off. Reset at the top of `run`. Holds the FD
table, so it depends on `vfs/vfs.zig`'s `FdTable` type — but for batch 1
(clock/random/proc/args_env) it doesn't need the FD table populated, so the
type can land first as an opaque/optional and be filled in batch 2.

```zig
// src/state.zig — per-run mutable state. Owned by main.zig; reset before
// every `run` invocation. All fields populated from scaffold_env at the
// start of run; nothing outlives a single run.

const std = @import("std");
const abi = @import("abi/types.zig");
// const vfs = @import("vfs/vfs.zig"); // batch 2

pub const EnvEntry = struct { key: []const u8, val: []const u8 };

pub const State = struct {
    /// Block timestamp from scaffold_env, in milliseconds.
    timestamp_ms: u64,
    /// Hash of the running contract block.
    contract_hash: [32]u8,
    /// PRNG seed = H(contract_hash || timestamp_ms_le); see prng.zig note.
    prng_seed: [32]u8,
    /// PRNG counter; advanced by random_get and /dev/random reads.
    prng_counter: u64,
    /// Monotonic clock counter, advanced by 1 per clock_time_get(MONOTONIC).
    monotonic_counter: u64,
    /// argv from wasi_setup. Each entry is the bare arg bytes (no NUL).
    argv: []const []const u8,
    /// env from wasi_setup. Order matters; preserved as listed.
    env: []const EnvEntry,
    /// cwd from wasi_setup. Defaults to "/".
    cwd: []const u8,
    /// Preopens from wasi_setup (e.g. {"/in", "/out", "/scratch", "/dev"}).
    preopens: []const []const u8,
    // /// File descriptor table. Stdio = 0/1/2, preopens start at 3. (batch 2)
    // fd_table: vfs.FdTable,
};

pub const InitArgs = struct {
    timestamp_ms: u64,
    contract_hash: [32]u8,
    /// Future: parsed wasi_setup. For batch 1, default everything.
    argv: []const []const u8 = &.{},
    env: []const EnvEntry = &.{},
    cwd: []const u8 = "/",
    preopens: []const []const u8 = &.{ "/in", "/out", "/scratch", "/dev" },
};

/// Backing storage for the singleton State. Lives in BSS — the shim has no
/// allocator beyond the bump arena in main.zig, and per-run state has a
/// fixed shape (no heap-allocated fields beyond the bump-arena slices).
var current_state: State = undefined;

/// Initialise the per-run state. Call once at the top of `run`. The slices
/// in `args` must have lifetime ≥ this run (typically they were just bumped
/// out of main.zig's bump arena from the wasi_setup parse).
pub fn init(args: InitArgs) void;

/// Borrow the current state. Lifetime: until the next `init`.
pub fn current() *State;
```

### 7. `src/abi/proc.zig` — proc_exit / proc_raise

Depends on `state` (none yet), `abi/types`, `scaffold/env`. Needed because
`main.zig` already references it.

```zig
// src/abi/proc.zig — proc_exit, proc_raise.
// proc_exit(0) is a clean termination; the run-side wrapper in scaffold
// recognises the EXIT_ZERO_REASON magic string and unwinds cleanly.

const env = @import("../scaffold/env.zig");

pub const EXIT_ZERO_REASON: []const u8 = "__SCAFFOLD_WASI_EXIT_ZERO__";

/// Never returns. Translates WASI exit semantics to a scaffold rejection;
/// the stacking-linker wrapper around `program._start` swallows the
/// EXIT_ZERO sentinel.
pub fn proc_exit(rval: i32) noreturn {
    if (rval == 0) {
        env.reject(EXIT_ZERO_REASON);
    } else {
        // Format "WASI proc_exit: <rval>" into a small fixed buffer.
        var buf: [40]u8 = undefined;
        const msg = std.fmt.bufPrint(&buf, "WASI proc_exit: {d}", .{rval}) catch unreachable;
        env.reject(msg);
    }
}

/// Always rejects: signals can't be delivered to a deterministic contract.
pub fn proc_raise(sig: i32) i32 {
    var buf: [40]u8 = undefined;
    const msg = std.fmt.bufPrint(&buf, "WASI proc_raise: {d}", .{sig}) catch unreachable;
    env.reject(msg);
}
```

### 8. `src/abi/clock.zig`, `src/abi/random.zig`, `src/abi/args_env.zig`

Once 1–7 are in place, these three are mostly transcription jobs against the
TS reference (`WasiImpl.wasi_clock_time_get` etc.). Each one:
- Reads input from program memory via `prog_mem.readU32` / `readU64`.
- Looks up state via `state.current()`.
- Writes output back via `prog_mem.writeU32` / `writeU64` / `writeSlice`.
- Returns `i32` errno.

Public API (one example each — the rest are mechanical):

```zig
// src/abi/clock.zig
pub fn clock_time_get(clock_id: i32, precision: i64, out_time: i32) i32;
pub fn clock_res_get(clock_id: i32, out_resolution: i32) i32;
```

```zig
// src/abi/random.zig
pub fn random_get(buf: i32, buf_len: i32) i32;
```

```zig
// src/abi/args_env.zig
pub fn args_get(argv_ptrs: i32, argv_buf: i32) i32;
pub fn args_sizes_get(out_argc: i32, out_buf_size: i32) i32;
pub fn environ_get(env_ptrs: i32, env_buf: i32) i32;
pub fn environ_sizes_get(out_count: i32, out_buf_size: i32) i32;
```

### 9. `src/scaffold/setup.zig` — wasi_setup parsing

Needed before argv/env produce real values (batch 1 can ship with empty
defaults from `state.init`). Parses the JSON `wasi_setup` record from
`scaffold_env.contract_metadata`. **Open question:** `std.json` does not
compile freestanding — either ship a tiny purpose-built JSON parser, or
change the design to accept a binary-encoded `wasi_setup` record. **Flag for
orchestrator.**

```zig
// src/scaffold/setup.zig — read and parse the wasi_setup record.
// Bumps strings out of main.zig's bump arena and returns slices.

pub const ParsedSetup = struct {
    argv: []const []const u8,
    env: []const state.EnvEntry,
    cwd: []const u8,
    preopens: []const []const u8,
    stdin: []const u8,
    stdout: []const u8,
    stderr: []const u8,
    extra_fds: []const struct { fd: u32, path: []const u8 },
};

/// Read `wasi_setup` from contract metadata, parse, return defaults if
/// absent. Allocates into the shim's bump arena via `main.alloc`.
pub fn read() ParsedSetup;
```

## Grouping of the 12 MVP calls into files

The design's batch-1/batch-2 split lines up cleanly with the file layout:

| File | Calls | Batch |
|---|---|---|
| `abi/proc.zig` | `proc_exit`, `proc_raise` | 1 |
| `abi/clock.zig` | `clock_time_get`, `clock_res_get` | 1 |
| `abi/random.zig` | `random_get` | 1 |
| `abi/args_env.zig` | `args_get`, `args_sizes_get`, `environ_get`, `environ_sizes_get` | 1 (deferred per design — listed as "second batch" but no FD-table dep, so cheap to land alongside batch 1) |
| `abi/unsupported.zig` | `sched_yield` (returns SUCCESS), `poll_oneoff`, all `sock_*`, `path_symlink`, `path_link` | 1 |
| `abi/fd.zig` | `fd_write`, `fd_read`, `fd_close`, `fd_seek`, `fd_fdstat_get`, `fd_fdstat_set_flags`, `fd_filestat_get`, `fd_readdir`, plus prestat helpers | 2 |
| `abi/path.zig` | `path_open`, `path_filestat_get` | 2 |

The 12-call MVP set splits 6/6 across batches: batch 1 is `proc_exit`,
`fd_write`, `fd_read`, `clock_time_get`, `random_get`, plus
`args_get`/`environ_get` family; batch 2 is `fd_close`, `fd_seek`,
`fd_fdstat_get`, `fd_fdstat_set_flags`, `fd_filestat_get`, `fd_readdir`,
`path_open`, `path_filestat_get`. Note that `fd_write` and `fd_read` are in
batch 1 in the design table but actually depend on the FD table (so they
land in batch 2 in this file layout). Batch 1 is "everything that doesn't
need an FD table" — clock, random, proc, args/env, sched.

## Risks / gaps for the orchestrator

1. **PRNG seed inputs** — design says `H(block_hash ‖ contract_hash)`, but
   the `scaffold_env` import surface in `main.zig` doesn't include
   `block_hash`. Either add the import (host-side change in
   `WasmHostBridge.ts`) or change the seed derivation. Blocks `random_get`
   and `/dev/random` until decided.
2. **`wasi_setup` encoding** — design says JSON, but `std.json` won't
   compile freestanding without an allocator. Need either a hand-rolled
   parser (~200 LOC for the subset we need) or a binary wire format. Blocks
   real argv/env values; doesn't block batch 1 if defaults suffice.
3. **`state.InitArgs` shape mismatch** — `main.zig`'s call to `state.init`
   passes only `timestamp_ms` and `contract_hash_packed`, but the State
   struct needs argv/env/cwd/preopens. Either widen `state.init` to call
   `setup.read()` itself, or have `main.run` call `setup.read()` and
   forward. Latter is cleaner; recommend that.
4. **No allocator for vfs nodes** — design rules out `std.heap`, but the
   memfs (batch 2) needs *some* allocation strategy for the in-memory
   `/scratch` tree. The bump arena in `main.zig` works for per-run
   allocations as long as we accept that `/scratch` is dropped at run end
   (which the design says). Worth confirming the bump arena size is enough
   (currently `1 MiB` start offset; bump grows from there but has no upper
   bound check — could overflow into `program_mem`-shared territory if a
   program writes a lot to `/scratch`).
5. **`abi/types.zig` and `std.os.wasi`** — Zig 0.16 `std.os.wasi` does
   define most of the WASI types but they're gated behind `target_os == .wasi`.
   On `wasm32-freestanding` they may be absent. Worth checking
   `std.os.wasi` availability with a tiny test build before assuming
   re-export works; otherwise the file is hand-written from the WASI
   header.
6. **`fd_renumber` / `fd_tell` etc. not in 12-call MVP** — `main.zig` stubs
   them with `notsup()`. Double-check this is OK for QuickJS (the first
   real-world target). If QuickJS calls `fd_tell`, it crashes immediately;
   a one-line implementation against `state.fd_table` would unblock that.
