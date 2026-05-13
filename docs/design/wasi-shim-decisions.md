# WASI Shim — Per-call Decisions Sheet

Build-team reference for the 12-call MVP defined in
[wasi-shim.md § Minimum Viable WASI Surface](./wasi-shim.md#minimum-viable-wasi-surface).
Read this before coding a call; it has every behavioural decision pre-resolved
so PRs don't relitigate spec ambiguities.

## How to read this sheet

- **Signature** is the C-ish form (matches `std.os.wasi` extern decls). Pointers
  are program-memory offsets; the shim never holds a program pointer for longer
  than one call.
- **Inputs read from program memory** lists every `program_mem.read_bytes`
  the call must perform, in order. Do them up-front; never read while holding
  state that would be inconsistent on a partial path.
- **Outputs written to program memory** lists every `program_mem.write_bytes`
  the call performs on success. On any non-`SUCCESS` errno, write nothing back
  unless explicitly noted (matches wasmtime + bjorn3).
- **Errno conditions** are listed in **priority order** — check from top to
  bottom, return on the first match. This is the order a real OS would report
  in (table-walk → arg validation → I/O), and matches what wasi-libc tests
  expect.
- **Reference cross-check** is a one-line digest per source. Where they
  diverge, the call's "Decisions" section picks one.
- **Determinism mapping** says how the call stays deterministic in scaffold.
- **Decisions** are numbered; build agents should be able to quote `path_open
  decision #4` without re-reading.

## Conventions assumed across all calls

These come from [wasi-shim.md § Reference-reconciled invariants](./wasi-shim.md#reference-reconciled-invariants)
and apply unless a per-call section overrides them:

1. The FD table is `ArrayList(?Fd)`; `null` slot ⇒ closed. Stdio at 0/1/2,
   preopens start at 3. Lookup of a closed or out-of-range FD ⇒ `EBADF` (8).
2. Rights are tracked per-fd but enforced only at the shim. Missing READ ⇒
   `EBADF` from `fd_read`; missing WRITE ⇒ `EBADF` from `fd_write`. We **do
   not** map rights failures to `EACCES` or `EPERM`. (Matches wasi-libc's
   expectation when wasi-libc requested fewer rights than the open succeeded
   with; mismatches a Linux POSIX intuition.)
3. Out-of-bounds program pointers ⇒ **trap** via `scaffold_env.reject`, not
   errno. We never return `EFAULT`. The host import is allowed to call
   `program_mem.read_bytes`/`write_bytes` with any offset; the JS forwarder
   bounds-checks against the program memory length and traps on overflow.
   Validate every `(ptr, len)` pair (iovec entries, name buffers) before the
   read/write call so the trap reason is informative.
4. All multi-byte integers in WASI structs are **little-endian**, naturally
   aligned to their size. Use `std.mem.writeInt(.little)` / `readInt(.little)`
   exclusively; never assume the host endianness.
5. The shim's bump allocator (`alloc()` in main.zig) is the only staging
   buffer. Reset by `run()`. Per-call scratch lives at the top of the bump
   pointer; if a call needs `> 64 KiB` of scratch (very large iovecs,
   multi-MiB readdir buffers), it must page-loop instead of bumping wildly.
6. **Errno values** come from `std.os.wasi.errno_t` (which matches the spec
   and `bjorn3/browser_wasi_shim`'s `wasi_defs.ts`). Numeric values listed in
   parens after each symbol below are FYI; depend on the enum, not the
   number.
7. Every catch-all path emits a `scaffold_env.reject` log via the panic
   handler in main.zig (no silent error swallowing — see AGENTS.md).

---

## `proc_exit`

**Signature**: `fn proc_exit(rval: u32) -> noreturn`

**Spec ref**: [WebAssembly/WASI preview1/docs.md § proc_exit](https://github.com/WebAssembly/WASI/blob/wasi-0.1/preview1/docs.md#proc_exit)

**Inputs read from program memory**: none.

**Outputs written to program memory**: none.

**Errno conditions** (in priority order):
| # | Condition | Outcome |
|---|---|---|
| 1 | `rval == 0` | call `scaffold_env.reject(EXIT_ZERO_REASON)` (a magic string) — the setup-side wrapper catches and treats as clean exit |
| 2 | `rval != 0` | call `scaffold_env.reject("WASI proc_exit: <decimal rval>")` — surfaces as a real `ContractRejection` |
| — | (never returns) | declared `noreturn`; both branches `unreachable` after reject |

**Reference cross-check**:
- `browser_wasi_shim`: throws a `WASIProcExit` JS exception. We use scaffold's
  reject machinery instead since traps unwind to scaffold cleanly while JS
  exceptions don't cross the WASM boundary.
- `wasmtime wasi-common`: validates exit status `< 126`, returns `I32Exit`.
  We don't validate — any u32 is allowed; the reason string carries it
  through.
- `wasi-libc usage`: `_Exit(0)` from a normal `main` return; `exit(N)` after
  `atexit` chain. Always lands here as a single call.
- `std.os.wasi`: `exitcode_t = u32`. We accept the i32 from the export and
  bitcast to u32 for the message format.

**Determinism mapping**: The exit code is part of the deterministic execution
trace. Same program + same inputs ⇒ same `proc_exit` value ⇒ same reject
reason. No external state involved.

**Decisions**:
1. The export takes `i32` (matches main.zig's committed signature) and
   bitcasts to `u32` before formatting — wasi's `exitcode_t` is u32.
2. The magic reason string for `rval == 0` is the constant
   `EXIT_ZERO_REASON = "__SCAFFOLD_WASI_EXIT_ZERO__"`, exported from
   `abi/proc.zig` so `setup.ts` can compare against it.
3. The reason format for `rval != 0` is exactly `"WASI proc_exit: <N>"`
   (no quotes, decimal rendering of `rval` as u32). Tests will assert on
   this string.
4. `proc_raise(sig)` (not in MVP but in the same file) calls
   `scaffold_env.reject("WASI proc_raise: <sig>")` — never returns. WASI
   doesn't define which signals are valid; we surface every call as a
   rejection.
5. Do not call `scaffold_env.emit_output` from `proc_exit`. The auto-close
   pass on open output FDs runs from `run()` after the program returns
   (which it can't on a nonzero exit — the reject traps first). Joel:
   **flag** — open `/out/record/...` writes will be lost on `proc_exit(N)`.
   That's the design (records require clean completion); document in the
   shim README.

---

## `fd_write`

**Signature**: `fn fd_write(fd: i32, iovs: u32, iovs_len: u32, nwritten: u32) -> errno_t`

**Spec ref**: [preview1/docs.md § fd_write](https://github.com/WebAssembly/WASI/blob/wasi-0.1/preview1/docs.md#fd_write)

**Inputs read from program memory**:
- `(iovs, iovs_len * 8)` — the `ciovec_t[]` array (each entry: `u32 buf, u32 buf_len`).
- For each entry `i`: `(ciovec[i].buf, ciovec[i].buf_len)` — the actual data.

**Outputs written to program memory**:
- `(nwritten, 4)` — `u32 LE` total bytes consumed across all iovecs.

**Errno conditions** (in priority order):
| # | Condition | Errno |
|---|---|---|
| 1 | FD slot null or out of range | `EBADF` (8) |
| 2 | FD does not have FD_WRITE right | `EBADF` (8) — see convention #2 |
| 3 | FD is a directory | `EISDIR` (31) |
| 4 | FD-backing path is read-only (e.g. `/in/...`) | `EBADF` (8) — surfaced as the rights check, since opening `/in/foo` for write returns `ENOTCAPABLE` at `path_open` and you never get a writable FD |
| 5 | `iovs_len == 0` | `SUCCESS`, write `0` to nwritten |
| 6 | iovec table or any iovec slice OOB in program memory | trap (see convention #3) |
| 7 | Closing-time emit fails (e.g. unknown output namespace) | does NOT happen here; emission is on `fd_close`, not on each write |
| — | otherwise | `SUCCESS` |

**Reference cross-check**:
- `browser_wasi_shim`: simple loop, returns `BADF` on missing fd, breaks on
  partial write. Doesn't enforce rights — relies on Fd subclass `fd_write`
  default returning `NOTSUP`. We enforce rights up-front (cleaner trace).
- `wasmtime wasi-common`: validates write access mode, calls
  `write_vectored`, hits the underlying file. Multi-iovec is always
  flattened by `write_vectored`. Same shape we want.
- `wasi-libc usage`: confirmed (cloudlibc `write.c`) — passes a **single
  iovec** every time. Multi-iovec only arrives via `writev(2)`. We still
  handle multi-iovec correctly because real `writev` users exist (e.g.
  printf-buffered runtimes).
- `std.os.wasi`: `ciovec_t = std.posix.iovec_const = extern struct { base:
  [*]const u8, len: usize }`. On wasm32 that's `(u32, u32)` = 8 bytes.

**Determinism mapping**: Bytes go to either `/out/debug` (logger),
`/out/record/...` (buffered until close → `emit_output`), or `/dev/null`
(discarded). All three sinks are deterministic.

**Decisions**:
1. Read the iovec table in **one** `program_mem.read_bytes` call (size
   `iovs_len * 8`), then iterate locally. Do **not** read entries one at a
   time — that's `iovs_len + 1` cross-memory hops vs. just `1 + iovs_len`.
2. For each iovec entry, `program_mem.read_bytes` directly into the FD's
   write buffer (or, for `/out/debug`, into a per-call line-buffer). No
   intermediate copy.
3. Cap `iovs_len` at `1024`. Any larger ⇒ `EINVAL` (28). Real wasi-libc
   never exceeds 16; this is a sanity bound to keep the bump allocator
   bounded.
4. Cap each iovec's `buf_len` at the remaining bump-allocator headroom.
   Exceeding ⇒ trap with reason `"fd_write: iovec exceeds shim heap"`.
   Programs that want hundreds of MiB per write must split.
5. Write `nwritten` after a `SUCCESS` only. On any errno, leave
   `*nwritten` untouched (matches both references and the spec — the spec
   does not promise a value on error).
6. `/out/debug` writes: forward to `ctx.logger('wasi-shim').debug(...)` per
   the design doc. Newline-flush; partial line buffered until next write or
   `fd_close`. Do not emit to scaffold output.
7. `/out/record/...` and `/out/output/...` writes: append to the FD's
   in-memory buffer; emit on `fd_close`, not here.
8. Empty write (`iovs_len > 0` but all `buf_len == 0`) returns `SUCCESS`
   with `nwritten = 0`. Do not call any sink.

---

## `fd_read`

**Signature**: `fn fd_read(fd: i32, iovs: u32, iovs_len: u32, nread: u32) -> errno_t`

**Spec ref**: [preview1/docs.md § fd_read](https://github.com/WebAssembly/WASI/blob/wasi-0.1/preview1/docs.md#fd_read)

**Inputs read from program memory**:
- `(iovs, iovs_len * 8)` — the `iovec_t[]` array (same shape as `fd_write`).

**Outputs written to program memory**:
- For each iovec entry `i`, up to `iovec[i].buf_len` bytes via
  `program_mem.write_bytes(iovec[i].buf, ...)`.
- `(nread, 4)` — `u32 LE` total bytes produced.

**Errno conditions** (in priority order):
| # | Condition | Errno |
|---|---|---|
| 1 | FD slot null or out of range | `EBADF` (8) |
| 2 | FD does not have FD_READ right | `EBADF` (8) |
| 3 | FD is a directory | `EISDIR` (31) |
| 4 | `iovs_len == 0` | `SUCCESS`, write `0` to nread |
| 5 | iovec OOB in program memory | trap |
| 6 | Underlying source produces error (e.g. fetch returns ENOENT after path_open) | `EIO` (29) — and log a warn |
| — | EOF — source produced 0 bytes when more were requested | `SUCCESS`, write the partial total to nread (zero is the EOF signal per the spec) |

**Reference cross-check**:
- `browser_wasi_shim`: same shape as fd_write, breaks on partial.
- `wasmtime wasi-common`: distinguishes shared vs. non-shared memory; uses
  intermediate buffer for shared. Not relevant — our memories are not
  WebAssembly.SharedArrayBuffer.
- `wasi-libc usage`: single iovec from `read(2)`; multi only via `readv(2)`.
- `std.os.wasi`: `iovec_t = std.posix.iovec = extern struct { base: [*]u8,
  len: usize }`. Same `(u32, u32)` wire form.

**Determinism mapping**: Sources are FD-backed:
- `/in/params`, `/in/timestamp`, `/in/contract_hash`, `/in/mode` — fixed
  bytes from `wasi_setup` / scaffold env.
- `/in/contract_metadata/.../...` — bytes from `scaffold_env.contract_metadata`.
- `/in/body/.../...` — bytes from `scaffold_env.request_body`.
- `/in/fetch/.../.../record_key` — bytes from `scaffold_env.fetch`.
- `/dev/random`, `/dev/urandom` — deterministic PRNG (see `random_get`).
- `/dev/zero` — zero bytes.
- `/dev/null` — EOF.
- `/scratch/...` — the in-memory tree.

All eight are deterministic by construction.

**Decisions**:
1. Same iovec batching as `fd_write`: one `program_mem.read_bytes` for the
   table, then per-entry `program_mem.write_bytes` straight from the source.
2. The FD carries a `read_pos: u64`. Each successful read advances it by
   the actual bytes produced. `fd_seek` mutates it; `path_open` initialises
   to 0 (no `O_APPEND` for read-only files).
3. Reads from `/dev/random` always succeed and always produce the requested
   length (the PRNG is infinite). Do not return EOF.
4. Reads from `/dev/null` always return `SUCCESS` with `nread = 0`.
5. Reads from `/dev/zero` always succeed and always produce the requested
   length, all zero bytes.
6. Reads past EOF on `/in/...` and `/scratch/...` return `SUCCESS` with the
   short count. Subsequent reads at EOF return `nread = 0`.
7. If `scaffold_env.fetch` returns "no such record" (length-zero result —
   the protocol uses `null` here but the wire-form `i64` returns `0` for the
   pointer half), treat as ENOENT-from-source ⇒ return `EIO` (29) and log
   `warn` because by this point `path_open` had already approved the path.
   (We can't return `ENOENT` from `fd_read` per spec — `fd_read`'s errno
   list doesn't include it. `EIO` is the closest semantic match.)
8. Cap `iovs_len` at `1024` like `fd_write`.

---

## `fd_close`

**Signature**: `fn fd_close(fd: i32) -> errno_t`

**Spec ref**: [preview1/docs.md § fd_close](https://github.com/WebAssembly/WASI/blob/wasi-0.1/preview1/docs.md#fd_close)

**Inputs read from program memory**: none.

**Outputs written to program memory**: none.

**Errno conditions** (in priority order):
| # | Condition | Errno |
|---|---|---|
| 1 | FD slot null or out of range | `EBADF` (8) |
| 2 | FD is a preopen (3..3+preopens.len) | `EBADF` (8) — closing preopens is illegal in our model. (bjorn3 allows it; wasmtime forbids it. We forbid: makes the trace readable.) |
| 3 | The close-side flush fails (e.g. `emit_output` traps) | the trap propagates; the FD slot is **already** nulled, so a retry sees `EBADF` |
| — | otherwise | `SUCCESS` |

**Reference cross-check**:
- `browser_wasi_shim`: marks fd undefined, pushes to free pool, delegates
  underlying close. Allows preopen close (silently no-ops). We diverge.
- `wasmtime wasi-common`: removes from table; returns `EBADF` for missing
  fd. Treats preopen specially via inheriting rights; close still works.
- `wasi-libc usage`: standard `close(2)` on each non-stdio fd; never closes
  preopens; `atexit` may close stdout/stderr.
- `std.os.wasi`: nothing struct-shaped; pure `(fd_t) -> errno_t`.

**Determinism mapping**: Close-time side effects:
- `/out/record/<key>` and `/out/output/<contract>/<params>/<amount>` ⇒
  `scaffold_env.emit_output` with the buffered bytes. Deterministic — same
  bytes in, same emit out.
- `/out/debug` ⇒ flush any partial line to `ctx.logger('wasi-shim').debug`.
  No scaffold side effect.
- `/dev/*`, `/in/*`, `/scratch/*` ⇒ no side effects.

**Decisions**:
1. Order of operations: (a) capture handle, (b) run handle-specific close
   (flush write buffer ⇒ `emit_output` if applicable), (c) null the slot
   and push the index to the free-list. Close-then-null is safer against
   a hypothetical re-entrant close handler that pokes back through
   `fd_table` — it would observe the slot still occupied (the original
   FD it was invoked on) rather than a confusing already-free state. If
   step (b) traps the slot stays occupied; the auto-close pass at run()
   exit walks the slot, but every close handler is one-shot guarded so a
   double-close is benign. A trap aborts the program anyway, so the leak
   window is one run.
2. Stdio FDs (0, 1, 2) **can** be closed by the program. Their slots null
   normally; subsequent reads/writes return `EBADF`. (wasi-libc expects this
   — stdout being closed is how some daemons signal end-of-output.)
3. Preopens (FDs in `3..3+preopens.len`) **cannot** be closed; return
   `EBADF`. Emit a `debug`-level log when the program tries.
4. The free-list is a `ArrayList(u32)` of indices. Allocation pops from the
   tail (LIFO); empty ⇒ append a new slot. Matches `bjorn3`'s pool reuse.
5. Auto-close on `run()` return: iterate every non-null slot in the FD
   table and call the same close handler. This covers programs that exit
   via normal `main` return without explicit `close`. Order: ascending FD
   index. (Order matters because two `/out/record/<same key>` opens are
   defined as two separate emits in close order — see wasi-shim.md §
   Write semantics.)
6. Auto-close does NOT run on `proc_exit(N != 0)` because the reject trap
   never returns. Document this; it's a real loss of pending writes. See
   `proc_exit` decision #5.

---

## `fd_seek`

**Signature**: `fn fd_seek(fd: i32, offset: i64, whence: u8 (passed as i32), newoffset: u32) -> errno_t`

**Spec ref**: [preview1/docs.md § fd_seek](https://github.com/WebAssembly/WASI/blob/wasi-0.1/preview1/docs.md#fd_seek)

**Inputs read from program memory**: none. (`offset` arrives as a value
parameter from the caller.)

**Outputs written to program memory**:
- `(newoffset, 8)` — `u64 LE` resulting absolute offset.

**Errno conditions** (in priority order):
| # | Condition | Errno |
|---|---|---|
| 1 | FD slot null or out of range | `EBADF` (8) |
| 2 | FD does not have FD_SEEK right (or the `tell` shortcut: `whence=CUR, offset=0`, FD_TELL right also OK) | `EBADF` (8) |
| 3 | FD is a directory | `EISDIR` (31) |
| 4 | FD-type is non-seekable (`/dev/random`, `/dev/zero`, `/dev/null`, `/out/debug`, stdio) | `ESPIPE` (70) |
| 5 | `whence` not one of SET/CUR/END (0/1/2) | `EINVAL` (28) |
| 6 | computed new offset overflows i64 (CUR/END addition) | `EINVAL` (28) (some impls use `EOVERFLOW=61`; we use INVAL because `filesize_t` is u64 — overflow is a logical inval, not a representation overflow) |
| 7 | computed new offset is negative | `EINVAL` (28) — POSIX disallows seeking before 0 |
| — | otherwise | `SUCCESS`, write resulting `u64` |

**Reference cross-check**:
- `browser_wasi_shim`: directly assigns; uses Number coercion (BUG — same
  one we're fixing). Returns `BADF` on missing fd.
- `wasmtime wasi-common`: full i64/u64 math via Rust `try_into()`; rejects
  negative final via `SeekFrom::Start` u64 conversion.
- `wasi-libc usage`: `lseek(2)` calls map straight through. `tell()` becomes
  `fd_seek(fd, 0, CUR, &out)` — no separate call.
- `std.os.wasi`: `whence_t = enum(u8) { SET, CUR, END }`. We accept `i32`
  per main.zig's signature and validate the bottom byte.

**Determinism mapping**: Pure local arithmetic on the FD's `read_pos`
field. No external state.

**Decisions**:
1. Use `i128` intermediates for CUR/END addition, then range-check into
   `i64` before assigning. Avoids the JS Number precision loss the TS
   reference suffers from.
2. Treat `whence` as `u8`; `whence > 2` ⇒ `EINVAL`. Don't forgive other
   bytes — we want the strict spec behaviour.
3. `/dev/random`, `/dev/zero`, `/dev/null`, stdio (when bound to debug),
   and `/out/debug` are **streams**: seek ⇒ `ESPIPE`. (POSIX returns
   ESPIPE for pipes/sockets/streams. wasi-libc maps this to `errno=29 EIO`
   for some stream types; we keep ESPIPE because that's what the spec
   lists.)
4. `/in/*` (file-backed) and `/scratch/*` (memfs) **are** seekable.
5. The "tell shortcut" — `whence=CUR, offset=0` — must work on FDs that
   only have FD_TELL right (not FD_SEEK). This is wasi-libc's `ftell()`
   path. Check FD_SEEK first, then if missing and `(whence,offset) =
   (CUR,0)`, accept on FD_TELL.
6. On EOF-anchored seeks: `whence=END`, `offset >= 0` is allowed and may
   place the cursor past EOF (POSIX hole semantics). Subsequent reads at
   that position return EOF; subsequent writes (on writable FDs) trap with
   reason `"fd_write: hole writes not supported"`. We don't synthesise
   zero-fill — no real WASI program sparse-writes through scaffold output.
7. End-relative for `/in/*` requires knowing the source size up-front. For
   small synthesised sources (`/in/params`, `/in/timestamp` etc.) the
   length is the bytes returned by the corresponding scaffold call. For
   `body`/`fetch`/`contract_metadata` the length is the result-length half
   of the `i64` that scaffold returned at `path_open` time; we cache it on
   the FD. Don't re-call scaffold on each `fd_seek`.

---

## `fd_fdstat_get`

**Signature**: `fn fd_fdstat_get(fd: i32, buf: u32) -> errno_t`

**Spec ref**: [preview1/docs.md § fd_fdstat_get](https://github.com/WebAssembly/WASI/blob/wasi-0.1/preview1/docs.md#fd_fdstat_get)

**Inputs read from program memory**: none.

**Outputs written to program memory**:
- `(buf, 24)` — the `fdstat` struct (see layout below).

**`fdstat` layout** (24 bytes, 8-byte aligned, all LE):

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `fs_filetype` | `u8`, see `filetype_t` |
| 1 | 1 | (pad) | implicit |
| 2 | 2 | `fs_flags` | `u16`, fdflags bitmask |
| 4 | 4 | (pad) | required by 8-byte alignment of next field |
| 8 | 8 | `fs_rights_base` | `u64` |
| 16 | 8 | `fs_rights_inheriting` | `u64` |

(The wasi-shim.md "20-byte struct" note is wrong — see DOC GAP at end. Use
24 bytes from `std.os.wasi.fdstat_t`.)

**Errno conditions** (in priority order):
| # | Condition | Errno |
|---|---|---|
| 1 | FD slot null or out of range | `EBADF` (8) |
| 2 | buf OOB in program memory (24 bytes from `buf`) | trap |
| — | otherwise | `SUCCESS` |

**Reference cross-check**:
- `browser_wasi_shim`: writes filetype@0 (u8), fdflags@2 (u16), base@8
  (u64), inheriting@16 (u64). Matches.
- `wasmtime wasi-common`: returns hardcoded fdstat for directories (DIR
  base+inheriting rights, empty fdflags); for files queries the underlying
  fd. Same shape.
- `wasi-libc usage`: called by `fcntl(F_GETFL)` and by stdio TTY detection.
  Programs read `fs_filetype` to decide if a fd is "interesting".
- `std.os.wasi`: `fdstat_t` extern struct above. Use `@bitCast` /
  `std.mem.writeInt` per field; do not `@ptrCast` the struct directly
  (wasm32 alignment is 4, not 8 — the struct's natural layout has a 4-byte
  pad at offset 4 which we must zero explicitly).

**Determinism mapping**: Pure function of FD state. No external lookup.

**Decisions**:
1. Use `std.os.wasi.fdstat_t` as the source of truth for layout. Explicitly
   zero bytes 1, 4..8 (the pad regions) so the trace is deterministic
   regardless of stack contents.
2. `fs_filetype` mapping for our FD types:
   - `/in/<file>`, `/in/.../<...>`, `/scratch/<file>`, `/out/record/...`,
     `/out/output/...` ⇒ `REGULAR_FILE` (4)
   - `/in/`, `/scratch/`, `/out/`, `/`, `/dev/` (directory FDs) ⇒
     `DIRECTORY` (3)
   - `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom` ⇒
     `CHARACTER_DEVICE` (2)
   - `/out/debug` ⇒ `CHARACTER_DEVICE` (2)
   - stdio (any binding) ⇒ same as the bound target's filetype
3. `fs_flags` reflects the FD's current flag set. We track APPEND and
   NONBLOCK only (the others — DSYNC/RSYNC/SYNC — are no-ops in our model
   and we always report them as 0). Even if the program set them via
   `fd_fdstat_set_flags` we don't store them — the next `_get` returns 0.
   That's a minor lie that wasi-libc accepts. (wasmtime stores; we don't,
   to keep state minimal.)
4. `fs_rights_base` is the full RIGHTS_REGULAR_FILE_BASE (or _DIRECTORY_BASE
   etc.) for the FD's filetype, masked by READ/WRITE based on how the FD
   was opened. Use the bitsets from `WasiConstants.ts` translated into Zig
   constants in `abi/types.zig`.
5. `fs_rights_inheriting` is `RIGHTS_DIRECTORY_INHERITING` for directories
   (so child opens can inherit), `0` for regular files / streams.

---

## `fd_fdstat_set_flags`

**Signature**: `fn fd_fdstat_set_flags(fd: i32, flags: u32) -> errno_t`

(Note: `flags` is `fdflags_t = u16` per spec, but ABI passes as `i32`.)

**Spec ref**: [preview1/docs.md § fd_fdstat_set_flags](https://github.com/WebAssembly/WASI/blob/wasi-0.1/preview1/docs.md#fd_fdstat_set_flags)

**Inputs read from program memory**: none.

**Outputs written to program memory**: none.

**Errno conditions** (in priority order):
| # | Condition | Errno |
|---|---|---|
| 1 | FD slot null or out of range | `EBADF` (8) |
| 2 | flags has bits outside the defined 5 (APPEND/DSYNC/NONBLOCK/RSYNC/SYNC) | `EINVAL` (28) |
| 3 | FD is non-seekable and APPEND is set (e.g. `/dev/random`) | `ENOTSUP` (58) |
| — | otherwise | `SUCCESS` |

**Reference cross-check**:
- `browser_wasi_shim`: sets `fileOffset` to file size on APPEND, sets
  `fileIsBlocking` from NONBLOCK. Doesn't validate other bits.
- `wasmtime wasi-common`: calls `set_fdflags` on the file entry. Returns
  `notsup` under wasi-threads. We always permit (no threads).
- `wasi-libc usage`: `fcntl(F_SETFL, O_APPEND | O_NONBLOCK)` for stream
  ops. Calls into here whenever `O_APPEND` toggles.
- `std.os.wasi`: `fdflags_t = packed struct(u16) { APPEND, DSYNC, NONBLOCK,
  RSYNC, SYNC, _: u11 }`. Reuse this; reject any high-bits.

**Determinism mapping**: Pure FD state mutation.

**Decisions**:
1. Store APPEND and NONBLOCK on the FD; ignore DSYNC/RSYNC/SYNC silently
   (no error, no storage — they don't affect determinism).
2. Setting APPEND on a writable file FD ⇒ snap `write_pos` to current
   buffered size. Setting APPEND on a non-writable FD ⇒ accept, no-op
   (wasi-libc sometimes sets APPEND on read FDs as part of `dup3` setup;
   real OSes accept).
3. NONBLOCK is stored but has no effect — all our reads are synchronous
   and instantly satisfiable. Programs that loop on EAGAIN won't see it
   (good; loops would be infinite in deterministic execution).
4. Reject any bit outside `0x001F` (the union of the 5 defined flags) with
   `EINVAL`. This catches misuse early; both references silently accept,
   but we prefer the strict signal.

---

## `fd_filestat_get`

**Signature**: `fn fd_filestat_get(fd: i32, buf: u32) -> errno_t`

**Spec ref**: [preview1/docs.md § fd_filestat_get](https://github.com/WebAssembly/WASI/blob/wasi-0.1/preview1/docs.md#fd_filestat_get)

**Inputs read from program memory**: none.

**Outputs written to program memory**:
- `(buf, 64)` — the `filestat` struct.

**`filestat` layout** (64 bytes, 8-byte aligned, all LE):

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 8 | `dev` | `u64`, our value: 0 |
| 8 | 8 | `ino` | `u64`, see decisions |
| 16 | 1 | `filetype` | `u8` |
| 17 | 7 | (pad) | zero |
| 24 | 8 | `nlink` | `u64`, our value: 1 |
| 32 | 8 | `size` | `u64`, see decisions |
| 40 | 8 | `atim` | `u64` (nanos), block timestamp ×10⁶ |
| 48 | 8 | `mtim` | `u64` (nanos), same |
| 56 | 8 | `ctim` | `u64` (nanos), same |

**Errno conditions** (in priority order):
| # | Condition | Errno |
|---|---|---|
| 1 | FD slot null or out of range | `EBADF` (8) |
| 2 | buf OOB | trap |
| — | otherwise | `SUCCESS` |

**Reference cross-check**:
- `browser_wasi_shim`: returns 0/0/type/0/size/0/0/0 for memfs. We're more
  determined.
- `wasmtime wasi-common`: dispatches to file or directory get_filestat;
  uses real OS values converted to Wasi types.
- `wasi-libc usage`: `fstat(2)` calls this; programs read `st_size` and
  `st_dev`/`st_ino` (e.g. CPython's import system uses inode for cache
  invalidation). Inode collisions across files are real bugs.
- `std.os.wasi`: `filestat_t` extern struct above. Same caveat as fdstat —
  write field-by-field; do not memcpy a Zig struct.

**Determinism mapping**: All fields are derived from the FD's static type
+ block timestamp. No wall clock.

**Decisions**:
1. `dev = 0` always. We have no concept of multiple devices.
2. `ino` is a hash of the path + FD-creation-counter, truncated to u64. Use
   `std.hash.Wyhash` over the canonical path bytes. Two distinct paths ⇒
   different inodes (at the rate of one collision per ~2³² files, fine).
   Two opens of the same path ⇒ same inode.
3. `filetype` per the same mapping table as `fd_fdstat_get` decision #2.
4. `nlink = 1` for files, `2` for directories (POSIX convention: dir has
   itself + `..` from any subdir; programs check `nlink >= 2` to detect
   "a directory").
5. `size` for files: actual data length (for `/in/*` it's the cached
   length from `path_open` time; for `/scratch/*` it's the memfs node
   length; for write-buffered FDs it's the buffered byte count; for
   streams `/dev/null`, `/dev/zero`, `/dev/random` it's `0`).
6. `atim = mtim = ctim = block_timestamp_ms * 1_000_000` (nanos). All
   three the same; no per-file mtime tracking.
7. Zero the 7-byte pad explicitly.

---

## `fd_readdir`

**Signature**: `fn fd_readdir(fd: i32, buf: u32, buf_len: u32, cookie: u64, bufused: u32) -> errno_t`

**Spec ref**: [preview1/docs.md § fd_readdir](https://github.com/WebAssembly/WASI/blob/wasi-0.1/preview1/docs.md#fd_readdir)

**Inputs read from program memory**: none.

**Outputs written to program memory**:
- `(buf, K)` — sequence of (24-byte dirent header + name bytes), where K
  is whatever fits up to `buf_len`.
- `(bufused, 4)` — `u32 LE` total bytes written.

**`dirent` header layout** (24 bytes, 8-byte aligned, all LE):

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 8 | `d_next` | `u64`, the cookie for the entry **after** this one |
| 8 | 8 | `d_ino` | `u64`, same Wyhash scheme as `fd_filestat_get` |
| 16 | 4 | `d_namlen` | `u32`, byte length of the name |
| 20 | 1 | `d_type` | `u8`, filetype |
| 21 | 3 | (pad) | zero |

(Header is 24 bytes; name follows immediately, no padding between header
and name; next dirent starts unaligned right after `name`. wasi-libc's
parser reassembles by walking namelen offsets, so we don't pad.)

**Errno conditions** (in priority order):
| # | Condition | Errno |
|---|---|---|
| 1 | FD slot null or out of range | `EBADF` (8) |
| 2 | FD is not a directory | `ENOTDIR` (54) |
| 3 | FD-backed dir is dynamic and unenumerable (`/in/body/0x...`, `/in/fetch/0x...`, `/in/contract_metadata/0x...`) | `ENOTSUP` (58) |
| 4 | buf+buf_len OOB | trap |
| 5 | cookie > current directory entry count | `SUCCESS`, `bufused = 0` (matches POSIX over-EOF semantics) |
| — | otherwise | `SUCCESS` |

**Reference cross-check**:
- `browser_wasi_shim`: writes header at offset 0..16 then advances; uses
  per-field bounds checks (early break). We do the same but in one go per
  entry to keep the trace tidy.
- `wasmtime wasi-common`: cookie-based, partial-fill signals "more
  available, call again"; an empty result signals EOF. Spec-compliant.
- `wasi-libc usage`: `getdents` loop calls `fd_readdir` with a 256-byte
  page-ish buffer in a loop, reads the cookie of the last full entry,
  passes it back as the new cookie. Stops when `bufused < buf_len`.
- `std.os.wasi`: `dirent_t = extern struct { next, ino, namlen, type }`.
  Use this for layout discipline.

**Determinism mapping**: The directory entry list is computed from the
shim's static structure (for `/`, `/in`, `/out`, `/dev`) or from the
in-memory tree (for `/scratch/*`, `/out/record/*`). Both deterministic.

**Decisions**:
1. `cookie` semantics: cookie `i` means "the entry at index `i` in the
   directory's stable, sorted entry list". Cookie `0` = first entry.
   `d_next` of the entry written at cookie `i` is `i+1`. EOF is signalled
   when `bufused < buf_len` (the spec's "less than buf_len = end" rule
   from wasmtime/the spec text).
2. **Always sort entries by name (byte-lexicographic)** before assigning
   cookies. This makes the trace deterministic across implementations of
   the underlying memfs.
3. The static directories have hard-coded sorted lists:
   - `/` ⇒ `dev, in, out, scratch` (alphabetical)
   - `/in` ⇒ `body, contract_hash, contract_metadata, fetch, mode,
     params, timestamp`
   - `/out` ⇒ `debug, output, record`
   - `/dev` ⇒ `null, random, urandom, zero`
4. `/out/record/...` and `/out/output/...` directories enumerate only
   what the program has touched in this run (matches wasi-shim.md). Sort
   by name as written.
5. Dynamic directories (`/in/body/0x.../`, `/in/fetch/0x.../`,
   `/in/contract_metadata/0x.../`) ⇒ `ENOTSUP`. Do **not** return empty
   success; programs interpret empty as "directory exists but no
   children", which is misleading.
6. Truncation rule: when an entry doesn't fit fully (header + namelen
   bytes), still write whatever fits up to `buf_len` and set `bufused =
   buf_len`. This is the spec's signal "more data available; call again
   with the same cookie". Do NOT bump `bufused < buf_len` in the
   truncation case — that would be misread as EOF.
7. If the dir is empty (no entries at all) ⇒ `SUCCESS`, `bufused = 0`.
   Same as cookie-past-end. wasi-libc handles both as EOF.

---

## `path_open`

**Signature**: `fn path_open(dirfd: i32, dirflags: u32, path: u32, path_len: u32, oflags: u32, fs_rights_base: u64, fs_rights_inheriting: u64, fdflags: u32, opened_fd: u32) -> errno_t`

**Spec ref**: [preview1/docs.md § path_open](https://github.com/WebAssembly/WASI/blob/wasi-0.1/preview1/docs.md#path_open)

**Inputs read from program memory**:
- `(path, path_len)` — UTF-8 path bytes, relative to `dirfd`.

**Outputs written to program memory**:
- `(opened_fd, 4)` — `u32 LE` newly assigned FD index.

**Errno conditions** (in priority order):
| # | Condition | Errno |
|---|---|---|
| 1 | dirfd slot null / OOR / not a directory | `EBADF` (8) / `ENOTDIR` (54) |
| 2 | path or path_len OOB in program memory | trap |
| 3 | `path_len > 4096` | `ENAMETOOLONG` (37) |
| 4 | `path_len == 0` | `EINVAL` (28) |
| 5 | path is absolute (starts with `/`) | `ENOTCAPABLE` (76) — must be relative to dirfd |
| 6 | path component `..` escapes the dirfd's preopen root | `ENOTCAPABLE` (76) |
| 7 | path resolves to a non-existent node and `O_CREAT` not set | `ENOENT` (44) |
| 8 | path resolves to existing node and `O_CREAT | O_EXCL` set | `EEXIST` (20) |
| 9 | path resolves to a directory and `oflags` would write to it (any of `O_TRUNC`, requested `FD_WRITE` right) | `EISDIR` (31) |
| 10 | path resolves to a regular file and `O_DIRECTORY` set | `ENOTDIR` (54) |
| 11 | path is in a read-only zone (`/in/*`) and write rights requested | `ENOTCAPABLE` (76) |
| 12 | path is in a write-only zone (`/out/*`) and read rights requested | `ENOTCAPABLE` (76) |
| 13 | path component contains `\0` byte | `EINVAL` (28) |
| 14 | trailing slash on a regular file | `ENOTDIR` (54) |
| — | otherwise | `SUCCESS`, write new FD index |

**Reference cross-check**:
- `browser_wasi_shim`: walks path segment-by-segment, supports `O_CREAT |
  O_EXCL | O_TRUNC | O_DIRECTORY`, doesn't enforce rights against zones.
- `wasmtime wasi-common`: full POSIX-shaped open via `cap-std`. Validates
  dirflags (SYMLINK_FOLLOW), maps oflags to OS oflags. Rights are checked
  against the dirfd's inheriting rights — if the requested base/inheriting
  exceeds, returns `ENOTCAPABLE`.
- `wasi-libc usage`: `open(2)` and `openat(2)` map directly. wasi-libc
  requests **near-max rights** in the rights bitmap (basically "give me
  everything for this filetype") and lets the host pick what to honour.
  This is why we treat the rights bitmap as informational, not as a
  capability check.
- `std.os.wasi`: `oflags_t = packed struct(u16) { CREAT, DIRECTORY, EXCL,
  TRUNC, _: u12 }`. `lookupflags_t = packed struct(u32) { SYMLINK_FOLLOW,
  _: u31 }`. `fdflags_t` as in fdstat.

**Determinism mapping**: Path resolution is pure string walking on a
deterministic FS. The newly assigned FD index is deterministic because
the free-list is a deterministic LIFO and `path_open` is the only
allocator.

**Decisions**:
1. Read the path bytes via `program_mem.read_bytes` into the bump
   allocator. Reject `path_len > 4096` immediately (saves a wasted bump).
2. Path normalisation runs before any FS lookup: split on `/`, collapse
   `.`, pop on `..` (respecting the dirfd's "preopen root" — `..` past it
   ⇒ `ENOTCAPABLE`), reject `\0`, strip a single trailing slash but
   remember it as `expects_directory`.
3. Reject absolute paths with `ENOTCAPABLE`. wasi-libc converts
   `open("/abs")` into `path_open(preopen_fd, "abs/...")` itself; we never
   see absolute paths.
4. `oflags` and `fdflags` are checked **as bits** for behaviour
   (`O_CREAT, O_EXCL, O_TRUNC, O_DIRECTORY` from oflags; `APPEND,
   NONBLOCK` from fdflags). Caller-requested rights are **clamped**, not
   rejected: see decision #5. Everything else in those words is silently
   ignored.
5. Read/write capability of the resulting FD comes from the **path zone**:
   each node declares a `NodeKind` on its vtable that determines the
   maximum supported rights set, and `path_open` clamps the caller's
   `rights_base` / `rights_inheriting` to that set (intersection).
   Synchronous `ENOTCAPABLE` at `path_open` was rejected because
   wasi-libc requests near-max rights as a default and would trip on it;
   the clamp model lets the open succeed and surfaces the right errno
   (BADF) at the per-call rights gate (`fd_read`/`fd_write`/`fd_seek`).
   The bitmap is enforced ONLY at the shim; OS-level enforcement is N/A
   because the shim is the FS. Per-zone supported rights:
   - `/in/*` ⇒ READ-only (FD_READ + FD_SEEK + FD_TELL +
     FD_FILESTAT_GET + FD_ADVISE)
   - `/out/record/*`, `/out/output/*` ⇒ WRITE + SEEK + filestat-set (the
     in-memory accumulator enforces sequential offsets, but SEEK is
     advertised so wasi-libc's "rewind on close" patterns work)
   - `/out/debug` ⇒ WRITE only (no SEEK -- it's a stream)
   - `/scratch/*` ⇒ READ + WRITE + SEEK + filestat-set + alloc
   - `/scratch` (and other directories) ⇒ READDIR + PATH_OPEN + the
     PATH_* mutation rights for memfs dirs; READ-only directory rights
     for `/in`, `/out`, `/dev` and their static sub-dirs
   - `/dev/null`, `/dev/zero` ⇒ READ + WRITE (both no-op for write)
   - `/dev/random`, `/dev/urandom` ⇒ READ + WRITE (writes discarded;
     wasi-libc opens these O_RDWR on some seed-init paths)
6. `O_CREAT` honoured only in `/scratch/*` and `/out/*`. In `/in/*` ⇒
   `ENOTCAPABLE`. In `/dev/*` ⇒ `EEXIST` (because the device nodes are
   pre-existing; `O_CREAT | O_EXCL` ⇒ `EEXIST`; `O_CREAT` alone ⇒
   succeed-as-existing).
7. `O_DIRECTORY` on a path that resolves to a regular file ⇒ `ENOTDIR`.
   `O_DIRECTORY` on `/out/record/foo` (dir-creating path) ⇒ create the
   directory entry in the in-flight tree and open it.
8. Newly opened FD index allocation: pop from free-list LIFO (matching
   `fd_close` decision #4); if empty, `append(table, fd)`. The first FD
   index after preopens (`3 + preopens.len`) and onward.
9. `path_filestat_get`-shaped pre-check: spec doesn't require it, but if
   the path is dynamic-fetchable (e.g. `/in/fetch/0x.../0x.../key`) we
   must call `scaffold_env.fetch` here to validate existence. Cache the
   resulting `(ptr, len)` on the FD for `fd_read`. If fetch returns
   length 0 with a null pointer ⇒ `ENOENT`.
10. Trailing slash handling: `path = "foo/"` ⇒ open `foo` and assert it's
    a directory; if it's a file ⇒ `ENOTDIR`.
11. Do NOT call `scaffold_env.contract_metadata` / `request_body` /
    `fetch` for `/in/...` opens that don't have a `contract_hash`/`params`
    sub-path — those are static (`/in/mode`, `/in/timestamp`,
    `/in/contract_hash`, `/in/params`). Cache the bytes for those at
    `wasi_setup` time; `path_open` just attaches the cached buffer.

---

## `path_filestat_get`

**Signature**: `fn path_filestat_get(dirfd: i32, flags: u32, path: u32, path_len: u32, buf: u32) -> errno_t`

**Spec ref**: [preview1/docs.md § path_filestat_get](https://github.com/WebAssembly/WASI/blob/wasi-0.1/preview1/docs.md#path_filestat_get)

**Inputs read from program memory**:
- `(path, path_len)` — UTF-8 path.

**Outputs written to program memory**:
- `(buf, 64)` — the same `filestat` layout as `fd_filestat_get`.

**Errno conditions** (in priority order):
| # | Condition | Errno |
|---|---|---|
| 1 | dirfd slot null / OOR / not a directory | `EBADF` / `ENOTDIR` |
| 2 | path OOB | trap |
| 3 | `path_len == 0` or `> 4096` | `EINVAL` / `ENAMETOOLONG` |
| 4 | absolute path / `..`-escape | `ENOTCAPABLE` |
| 5 | path resolves to non-existent node | `ENOENT` |
| 6 | dynamic-fetchable path that returns no record | `ENOENT` |
| — | otherwise | `SUCCESS` |

**Reference cross-check**:
- `browser_wasi_shim`: re-uses path resolver from `path_open`. Returns
  filestat from the resolved node.
- `wasmtime wasi-common`: calls `get_path_filestat` on the directory entry.
- `wasi-libc usage`: `stat(2)` and `lstat(2)`. Programs use this all over
  (CPython on every `import`).
- `std.os.wasi`: same `filestat_t` struct.

**Determinism mapping**: Same as `fd_filestat_get` — derived from path
type + block timestamp.

**Decisions**:
1. Share the path-resolution helper with `path_open`. Only difference:
   no FD allocation, no rights, no oflag handling — just resolve to a
   node descriptor and emit the filestat.
2. For dynamic-fetchable paths (`/in/body/.../...`, `/in/fetch/.../...`,
   `/in/contract_metadata/.../...`) we MUST call the scaffold env to
   determine `size`. Cache the result so a subsequent `path_open` doesn't
   re-call. (Use a small per-run LRU keyed by canonical path; bound at
   ~16 entries.)
3. `flags` (lookupflags) — only `SYMLINK_FOLLOW` (bit 0) is defined; we
   don't have symlinks, so the flag is ignored.
4. All other fields per `fd_filestat_get` decisions.

---

## `clock_time_get`

**Signature**: `fn clock_time_get(clock_id: u32, precision: u64, time: u32) -> errno_t`

**Spec ref**: [preview1/docs.md § clock_time_get](https://github.com/WebAssembly/WASI/blob/wasi-0.1/preview1/docs.md#clock_time_get)

**Inputs read from program memory**: none.

**Outputs written to program memory**:
- `(time, 8)` — `u64 LE` nanoseconds.

**Errno conditions** (in priority order):
| # | Condition | Errno |
|---|---|---|
| 1 | `clock_id` not in {0,1,2,3} | `EINVAL` (28) |
| 2 | time OOB | trap |
| — | otherwise | `SUCCESS` |

**Reference cross-check**:
- `browser_wasi_shim`: `Date.now() * 1e6` for REALTIME, `performance.now()
  * 1e9` for MONOTONIC. **Both non-deterministic** — we replace.
- `wasmtime wasi-common`: REALTIME = `SystemTime::now()`, MONOTONIC =
  duration since clock creation. Rejects `PROCESS_CPUTIME_ID` and
  `THREAD_CPUTIME_ID` with `notsup`. We accept all four (deterministic
  mapping below).
- `wasi-libc usage`: REALTIME for `time(2)` / `gettimeofday(2)`;
  MONOTONIC for `clock_gettime(CLOCK_MONOTONIC)`. JS-on-wasi runtimes
  call this **a lot** (every `Date.now()` and `performance.now()`).
- `std.os.wasi`: `clockid_t = enum(u32) { REALTIME, MONOTONIC,
  PROCESS_CPUTIME_ID, THREAD_CPUTIME_ID }`. `timestamp_t = u64`.

**Determinism mapping** (per wasi-shim.md "Determinism" table):
- `REALTIME` ⇒ `block_timestamp_ms * 1_000_000` (constant for the run)
- `MONOTONIC` ⇒ `++monotonic_counter_ns` (incremented BEFORE returning;
  starts at 0; first call returns 1)
- `PROCESS_CPUTIME_ID` ⇒ same as MONOTONIC (shares the same counter)
- `THREAD_CPUTIME_ID` ⇒ same as MONOTONIC

**Decisions**:
1. Ignore `precision` entirely. It's a hint, not a requirement.
2. The monotonic counter lives on `state.zig`, initialised to 0 in
   `state.init`. Increment by `1` and return (i.e. first observation = 1).
   This guarantees a `while(t1 == t2) { t1 = clock(); }` busy-loop
   terminates after 2 iterations.
3. All four MONOTONIC-shaped clocks share the **same** counter. A program
   that interleaves them sees a single increasing sequence. (wasmtime
   distinguishes; we don't, because cpu-time semantics are meaningless
   without a CPU.)
4. The block timestamp is captured once at `run()` startup via
   `scaffold_env.timestamp()`. Don't re-call.

---

## `random_get`

**Signature**: `fn random_get(buf: u32, buf_len: u32) -> errno_t`

**Spec ref**: [preview1/docs.md § random_get](https://github.com/WebAssembly/WASI/blob/wasi-0.1/preview1/docs.md#random_get)

**Inputs read from program memory**: none.

**Outputs written to program memory**:
- `(buf, buf_len)` — the requested random bytes.

**Errno conditions** (in priority order):
| # | Condition | Errno |
|---|---|---|
| 1 | buf+buf_len OOB | trap |
| 2 | `buf_len == 0` | `SUCCESS`, no-op |
| 3 | `buf_len > 1 << 24` (16 MiB) | `EINVAL` (28) — sanity bound, real callers ask for 32–64 bytes |
| — | otherwise | `SUCCESS` |

**Reference cross-check**:
- `browser_wasi_shim`: `crypto.getRandomValues` in 64 KiB chunks.
  Non-deterministic — we replace.
- `wasmtime wasi-common`: writes from a `RngCore` stream; chunked for
  shared memory. We follow the chunked approach but with our PRNG.
- `wasi-libc usage`: `getentropy(3)` and `arc4random_buf(3)` map directly.
  Typical sizes: 16 / 32 / 256 bytes. JS runtimes' `Math.random()` use
  this for seeding.
- `std.os.wasi`: nothing struct-shaped.

**Determinism mapping**: Counter-mode PRNG defined in wasi-shim.md
`/dev/random and /dev/urandom`: `H(seed || counter)`, 32 bytes per
counter step, where `seed = H(contract_hash || timestamp_ms_le8 || params)`
captured at `run()` startup (see `src/contracts/wasi-shim/src/state.zig`).
The PRNG state is shared with reads from `/dev/random` and `/dev/urandom`.

**Decisions**:
1. The PRNG hash function is `Hash.digest` (whatever scaffold uses; check
   `src/core/Hash.ts` — likely SHA-256 or BLAKE3). Mirror exactly to
   ensure cross-impl determinism.
2. Stage in 32-byte blocks; copy partial last block. The scaffold-side
   `Hash.digest` runs on host, not via cross-memory; the staging buffer
   lives in the bump allocator.
3. Use one `program_mem.write_bytes` per output chunk (not per 32-byte
   block) — coalesce all chunks into one shim-side buffer and write once.
   Cap at the bump allocator's free space; if `buf_len` exceeds, page-loop.
4. `random_get` and `/dev/random` reads share the same `position` counter
   on `state.zig`. Order of consumption is deterministic by program
   execution order.
5. Empty request (`buf_len == 0`) is a SUCCESS no-op. Matches both
   references.
6. The 16 MiB cap is a smell test — programs asking for 16 MiB of
   randomness are doing something pathological. If a real program needs
   more, lift the cap and document it.

---

## argv/env addendum

The four `args_*` / `environ_*` calls are deterministic-by-construction
because `wasi_setup.argv` and `wasi_setup.env` are baked into the contract
block. They get the short treatment:

### `args_sizes_get(out_argc: u32, out_buf_size: u32) -> errno_t`

- Read the cached `argv` from `state.zig`.
- Write `argc` (count) at `out_argc`, total byte count (sum of each
  arg's UTF-8 length + 1 for trailing NUL) at `out_buf_size`. Always
  `SUCCESS`.

### `args_get(argv_ptrs: u32, argv_buf: u32) -> errno_t`

- Walk `argv`, write each NUL-terminated string into `argv_buf`,
  recording the per-arg start offset in `argv_ptrs[i]` (each as `u32`
  pointing into program memory). All writes via `program_mem.write_bytes`.
  Always `SUCCESS`.

### `environ_sizes_get(out_count: u32, out_buf_size: u32) -> errno_t`

- Same shape as `args_sizes_get` but on the `env` map. Each entry is
  rendered as `KEY=VALUE\0`; total bytes is the sum of those.

### `environ_get(env_ptrs: u32, env_buf: u32) -> errno_t`

- Same shape as `args_get`. Order: as listed in `wasi_setup.env`
  (insertion order — JSON object iteration order for the JSON-deserialised
  `Record<string, string>`). Test expectations should not depend on
  alphabetical ordering.

**Errno conditions** for all four: only memory-OOB ⇒ trap. Otherwise
`SUCCESS`. `EINVAL` is not used.

**Determinism**: All four are pure functions of `wasi_setup`; trivially
deterministic.

**Decisions**:
1. `wasi_setup` is parsed once at `run()` startup. Argv strings are stored
   as length-prefixed buffers in the bump allocator (the bump allocator
   is reset per run, so they don't leak).
2. NUL termination: argv/env strings get a trailing `\0` appended in the
   buffer; pointer table points to the first byte; total byte size in
   `_sizes_get` includes the terminators.
3. Empty argv / empty env returns `argc = 0` / `count = 0`, `buf_size =
   0`. `_get` then is a no-op success.

---

## Doc gap (flagged for orchestrator)

**`fdstat` size**: wasi-shim.md § Minimum Viable WASI Surface row for
`fd_fdstat_get` says "20-byte struct". The actual struct is **24 bytes**
(filetype@0 + fdflags@2 + 4-byte pad + 8-byte base + 8-byte inheriting).
This sheet uses the correct 24. The design doc should be patched.

**`fd_close` of preopens**: bjorn3 allows it (silent no-op); we forbid
(EBADF). The design doc doesn't say. This sheet picks "forbid" (decision
above). Worth adding a one-liner to wasi-shim.md.

**`fd_seek` past EOF on writable FDs**: We trap on hole-writes
(`fd_seek` decision #6). The design doc is silent. This sheet picks
"trap, don't synthesise zero-fill". Worth adding a one-liner.

**`/dev/random` writes discarded**: design doc says "Writes to
`/dev/random` and `/dev/urandom` are discarded". We additionally accept
write-FD opens of these paths so wasi-libc's seed-init paths don't fail
(`path_open` decision #5). This is consistent with the design intent;
no patch required, but tests should cover it.
