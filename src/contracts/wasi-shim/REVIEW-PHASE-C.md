# Phase C Peer Review (fd.zig + path.zig + memfs helpers + main.zig wiring)

## Verdict

**changes-requested.** One blocker, one major, several minors. Most of the
file shapes are right (struct serialisers are clean, vtable plumbing is
consistent, determinism is preserved -- no wall clock, no host entropy), but
the path-mutation code path has a real bug that breaks the most common
`creat`-shaped wasi-libc call, and the rights/zone gating in `path_open`
silently disagrees with the decision sheet. Reviewer focused on the Phase C
checklist points; numbered list below.

## Findings

### [severity: blocker] path.zig:247-256, 400-406, 451-457, 502-509 -- single-segment leaves under any dirfd hit `INVAL` instead of doing the right thing

`splitParentLeaf("foo")` returns `.parent = "", .leaf = "foo"` (correct --
there is no parent path, just a leaf relative to `start`). Every caller then
does:

```zig
const parent_resolve = normalisePath(start, split.parent) catch |err|
    return @intFromEnum(errnoFromNormalise(err));
```

But `normalisePath("")` returns `error.Empty` → `errnoFromNormalise` → `INVAL`.

Effect: every `path_open(scratch_dirfd, "newfile", O_CREAT)` (the canonical
`creat(2)` shape from wasi-libc), every `path_create_directory(scratch_dirfd,
"newdir")`, every `path_unlink_file(scratch_dirfd, "victim")`, every
`path_remove_directory(scratch_dirfd, "victim")`, and every
`path_rename(..., "old", ..., "new")` against a top-level leaf in either
dirfd returns `INVAL`. This is the most common shape for all five calls.

The fix is local to each caller (or shared in a helper): when
`split.parent.len == 0`, treat `start` itself as the parent without going
through `normalisePath`. Sketch:

```zig
const parent = if (split.parent.len == 0) start else blk: {
    const r = normalisePath(start, split.parent) catch |err|
        return @intFromEnum(errnoFromNormalise(err));
    break :blk r.node;
};
```

This is also why `tests/abi_path.zig`-style coverage of CREAT against a fresh
leaf in `/scratch` doesn't currently exist -- the unit tests only exercise
the normaliser, not the full `path_open` CREAT path. Add a snapshot test in
Phase E that opens `/scratch/foo` with CREAT|TRUNC|WRONLY against a real
preopen and asserts `fd_close` writes a record. (Or better: add a Zig-side
test in path.zig that mocks the FD table + memfs root and exercises the
full path.)

### [severity: major] path.zig:178, 215-225 -- `path_open` ignores zone-based rights gating from `path_open` decision #5/#11/#12

The decision sheet (path_open decisions #5, #11, #12) is explicit:

> Read/write capability of the resulting FD comes from the **path zone**,
> not from the rights bitmap.
> - `/in/*` ⇒ READ-only
> - `/out/*` ⇒ WRITE-only
> - `/scratch/*` ⇒ READ + WRITE + SEEK
> - ...
>
> path is in a read-only zone (`/in/*`) and write rights requested →
> `ENOTCAPABLE`
> path is in a write-only zone (`/out/*`) and read rights requested →
> `ENOTCAPABLE`

The implementation:

```zig
.rights_base = @bitCast(rights_base),
.rights_inheriting = @bitCast(rights_inheriting),
```

just stores whatever the caller passed -- no zone-based override and no
ENOTCAPABLE check. Today this kind of works because `populateFdTable` hands
`std.math.maxInt(u64)` to preopens, the input/output node implementations
return `ReadOnly`/`IsADirectory` from their write/read vtables respectively,
and the abi layer translates those to `ROFS`/`ISDIR`. So the program does
get an error -- just the wrong one (ROFS instead of NOTCAPABLE, surfaced
later from `fd_read`/`fd_write` instead of synchronously from `path_open`).

Because `path_open` is the design's gating point, the user-visible errno is
wrong and the asynchronous reporting confuses programs that try to recover
from `path_open` errors before allocating buffers. Fix: in `finishOpen`,
mask `rights_base`/`rights_inheriting` against the zone's allowed rights
(derived from a `vtable.kind` field or a small per-node-type lookup), and
return ENOTCAPABLE when the caller's requested rights exceed the zone's
mask. The decision sheet has the exact masks.

If you keep "store the bitmap as-is" semantically, at least drop the
`rights_base & RIGHT_FD_READ`/`RIGHT_FD_WRITE` enforcement in
`fd_read`/`fd_write` -- otherwise the rights bitmap is *both* "informational"
*and* enforced, which is the worst of both worlds (it can break wasi-libc
which doesn't always pass the rights it later reads against, and it gives
wrong errnos). Pick one model.

### [severity: major] fd.zig:62-91, 119-155 -- iovec entry `(ptr, len)` not pre-validated; relies on host trap for OOB but loses the informative reason

Reviewer focus item #9 and the design's "Reference-reconciled invariants"
note #3 ("Validate every (ptr, len) pair (iovec entries, name buffers)
before the read/write call so the trap reason is informative") are not
honoured. The code passes `iov.buf + pulled` and `iov.buf_len` straight to
`prog_mem.readSlice` and lets the JS forwarder bounds-check. Two concrete
problems:

1. `iov.buf + pulled` is `u32` arithmetic on wasm32. A pathological iovec
   with `iov.buf = 0xFFFF_F000`, `iov.buf_len = 0x0000_2000` wraps the
   addition silently (in `ReleaseSmall` the wrap is defined; in safe-debug
   it traps with an unhelpful "integer overflow" reason). Either way the
   shim has no chance to emit a meaningful reject reason like `"fd_write:
   iovec[3] overflows program memory"`.
2. Each entry's `(ptr, len)` should be validated *before* the read/write
   call so the trap reason names the iovec index. Today a host trap from
   `read_bytes` surfaces as a bare "out of bounds memory access", losing
   the iovec index that wasi-libc would need to debug a misaligned struct.

Fix: in both `fd_write` and `fd_read`, after decoding each iovec, check
`@as(u64, iov.buf) + @as(u64, iov.buf_len) <= program_memory_size_bytes`
(or use `std.math.add` with overflow check) and `panic` with a per-call
prefix on failure. That way the trap reason carries the iovec index and
the shim never invokes `read_bytes`/`write_bytes` with overflowing offsets.

### [severity: major] fd.zig:170 -- `fd_close` of a preopen returns `NOTCAPABLE`, decision sheet says `BADF`

Decision sheet `fd_close` decision #3 is explicit:

> Preopens (FDs in `3..3+preopens.len`) **cannot** be closed; return
> `EBADF`.

Implementation:

```zig
if (entry.preopen_path != null) return errno(.NOTCAPABLE);
```

returns NOTCAPABLE. wasi-libc's `close(2)` shim probes for closeable FDs
during atexit cleanup and stops the iteration on the first BADF; NOTCAPABLE
keeps it iterating, which can eat real cleanup work later in the table.

Fix: return `errno(.BADF)`.

### [severity: minor] fd.zig:178-181 -- `fd_close` order of operations differs from decision sheet (close-then-null vs null-then-close)

Decision sheet decision #1:

> Order of operations: (a) capture handle, (b) null the slot, (c) push
> index to free-list, (d) run handle-specific close (flush write buffer
> ⇒ `emit_output` if applicable). If step (d) traps, the slot stays null
> -- that's acceptable.

Implementation:

```zig
const node = entry.node;
node.vtable.close(node);
fd_table.free(@intCast(fd)) catch return errno(.BADF);
```

closes first, then frees. If `close` traps (e.g. `emit_output` rejects),
the FD slot is left occupied. The auto-close pass on the next `run` would
re-fire -- except `run` resets the FD table via `state.init`, so the leak
is per-run-bounded. Functionally equivalent in our deterministic execution
model, but the divergence from the decision sheet should be either fixed or
the comment in fd.zig:174-177 should be updated to acknowledge the choice
("we do close-then-free; the decision sheet's null-first ordering would be
more conservative but makes no difference because a trap aborts the run
anyway").

Pick one; today the source comment (lines 174-177) describes a
null-first-then-close ordering that the code doesn't implement.

### [severity: minor] fd.zig:201-204 -- `fd_seek` filetype check order differs from decision sheet (CHARACTER_DEVICE before DIRECTORY)

Decision sheet condition table:
1. BADF (slot)
2. BADF (rights)
3. **EISDIR** (directory)
4. **ESPIPE** (non-seekable)

Implementation:
```zig
if (stat_res.filetype == .CHARACTER_DEVICE) return errno(.SPIPE);
if (stat_res.filetype == .DIRECTORY) return errno(.ISDIR);
```

Functionally identical (no FD is both a directory and a character device),
but the sheet's order matches what wasi-libc tests assert. Trivial swap;
do it for consistency with the spec table.

### [severity: minor] fd.zig:262-277 -- `fd_fdstat_set_flags` doesn't enforce decision #3 (APPEND on non-seekable ⇒ ENOTSUP)

Decision sheet condition #3:

> FD is non-seekable and APPEND is set (e.g. `/dev/random`) → `ENOTSUP`

The implementation accepts and stores APPEND on every FD without checking
filetype. Real wasi-libc occasionally sets APPEND on /dev/* during stream
init paths (rare); silently accepting hides the mistake. Add a stat check
analogous to fd_seek's: if `stat.filetype == .CHARACTER_DEVICE && (flags &
APPEND) != 0`, return NOTSUP.

(Also note: the current store overwrites *every* tracked flag on each call,
not just APPEND/NONBLOCK -- the mask happens to capture only those because
FDFLAGS_STORED_MASK selects them, but a future extension that adds another
stored flag has to remember to widen the mask. Comment is good; behaviour
is right.)

### [severity: minor] fd.zig:294-297 -- `fd_filestat_get` reports `ino = 0` for every node; decision sheet calls for Wyhash-based stable inodes

Decision sheet `fd_filestat_get` decision #2 calls for
`Wyhash(canonical_path)` truncated to u64 so distinct paths get distinct
inodes (CPython's import cache compares inodes for cache invalidation).
Implementation hardcodes `ino = 0` for every node and rationalises this as
"matches what wasmtime does for memfs."

For QuickJS this is fine -- it doesn't stat in a way that compares inodes.
For the eventual CPython graduation target it will be wrong: every imported
module will look like the same file and the import cache will collapse.

Acceptable for v1 given the staged target list, but add a `TODO.md` entry
("upgrade fd_filestat_get / path_filestat_get inode to a stable Wyhash
of canonical path before the CPython graduation milestone"). Don't ship
this to CPython without lifting it.

### [severity: minor] path.zig:547-562 -- `path_symlink`/`path_link`/`path_readlink` errnos diverge from the design's behaviour table

Design § Determinism table says:

> `path_symlink` / `path_link` | `EROFS` everywhere except `/scratch`; in
> `/scratch`, `ENOTSUP` (avoid the graph cases)

and the design's Out-of-Scope section says symlinks are universally
ENOTSUP. The implementation picks ENOTSUP universally for `path_symlink`
and `path_link` (consistent with Out-of-Scope; the comment acknowledges
this). For `path_readlink` it returns NOENT, which matches neither the
behaviour table nor Out-of-Scope.

Two options:
(a) Patch the design doc to say "all three return NOTSUP universally; we
    don't bother with zone discrimination because no real program calls
    them," and change `path_readlink` to also return NOTSUP.
(b) Implement zone discrimination per the table, with NOTSUP only inside
    /scratch.

(a) is cleaner for v1 (and what the agent intended). Pick (a) and patch
both the design doc and `path_readlink`'s return to match.

### [severity: minor] path.zig:266-267, 410-411 -- `arenaOf(parent) orelse return IO` is a silent fallthrough

```zig
const arena = memfs.arenaOf(parent) orelse
    return @intFromEnum(abi.Errno.IO);
```

`arenaOf` returns null only when `parent` isn't a memfs dir. But the code
just checked `memfs.isMemfsDir(parent)` two lines up (in `path_open`'s
case) or via `mutationGate`. So `arenaOf` returning null here is impossible
-- yet the IO-return fallback hides what would otherwise be a logic bug.
Per AGENTS.md "Never drop errors silently": this should `unreachable` or
a panic with an explicit reason like `"path mutation: parent passed
isMemfsDir but arenaOf returned null -- vfs invariant broken"`. Today a
future refactor that loosens `isMemfsDir` would silently route to IO.

Fix: replace the `orelse return IO` with `orelse @panic("memfs invariant:
isMemfsDir true but arenaOf null")` or similar.

### [severity: minor] path.zig:418-423 -- post-`addChild`-fail probe via `lookup` could itself fail for non-OOM reasons

```zig
if (!memfs.addChild(parent, split.leaf, new_dir)) {
    const lookup = parent.vtable.lookup orelse
        return @intFromEnum(abi.Errno.IO);
    if (lookup(parent, split.leaf)) |_| {
        return @intFromEnum(abi.Errno.EXIST);
    } else |_| {
        return @intFromEnum(abi.Errno.NOSPC);
    }
}
```

The `lookup ... else |_|` arm catches *every* lookup error and reports
NOSPC. Most lookup failures are NotFound (which here means OOM since
addChild succeeded a bytes-allocation only), but a future memfs lookup
that returns BadFd or NotADirectory would be hidden as NOSPC. Per
AGENTS.md, switch on the error variant: NotFound → NOSPC (real OOM),
anything else → propagate via `errnoFromVfs(err)`.

Same pattern likely applies in `removeChild`/`rename` callers (haven't
re-verified each), but they go through `errnoFromVfs` already so they're
fine. Just this one spot.

### [severity: minor] fd.zig:330-345 -- `fd_readdir` truncation case writes a header with `d_next = next_cookie + 1`, but `next_cookie` isn't bumped (correct behaviour, slightly confusing comment)

The truncation case at line 376-396 does NOT bump `next_cookie` (correct),
so the program's next call uses the same cookie and sees the truncated
entry whole. But the truncated header contains `d_next = next_cookie + 1`,
which advertises the cookie *after* this entry. Since the program uses
the *last full entry's* `d_next` as its next cookie, the truncated
header's `d_next` is unread -- which is right, but the code is a bit
confusing.

Tiny fix: add a comment at the truncation path noting that the partial
header's `d_next` value is intentionally meaningless because wasi-libc
ignores it (it tracks the cookie of the last fully-written entry).

### [severity: minor] memfs.zig:148-162 -- `MemfsFile.write` uses `start + src.len` and `growCapacity` doubling without overflow guards

```zig
const end = start + src.len;
if (end > file.capacity) {
    const new_cap = growCapacity(file.capacity, end);
```

On wasm32 `usize` is u32 (max ~4 GiB). For staging-bounded writes (≤ 16 KiB
per chunk) this is safe today, but `growCapacity`'s `cap *= 2` loop will
silently wrap at `usize.maxInt` and produce a tiny `new_cap` that's
smaller than `needed`, then alloc succeeds with insufficient space, then
the `@memcpy` at line 160 traps. The trap reason will be unhelpful.

In practice unreachable (the bump arena is bounded), but worth a defensive
check: if `cap >= std.math.maxInt(usize) / 2` after a doubling round, fail
with `OutOfSpace`.

### [severity: nit] fd.zig:194 -- `is_tell_shortcut` evaluates `whence == @intFromEnum(abi.Whence.CUR)` without first range-checking `whence`

```zig
const has_seek = (entry.rights_base & abi.RIGHT_FD_SEEK) != 0;
const is_tell_shortcut = whence == @intFromEnum(abi.Whence.CUR) and offset == 0;
const has_tell = (entry.rights_base & abi.RIGHT_FD_TELL) != 0;
if (!has_seek and !(is_tell_shortcut and has_tell)) return errno(.BADF);
```

`whence == 1` works whether whence is i32 1 or some other negative value
that happens to equal 1 by bitcast. Range-check (`whence >= 0 and whence
<= 2`) is done later, but the ordering means a bad whence with FD_SEEK
right takes the rights-pass branch and *then* gets caught by the whence
check on line 207. Fine functionally, slightly out of order vs the
decision sheet. Optional swap.

### [severity: nit] fd.zig:317 -- `DIRENT_HEADER_BYTES` duplicates a layout constant that `types.zig` could expose

The 24-byte dirent header layout is a WASI wire constant. types.zig exposes
the layout for `Iovec`, `Fdstat`, `Filestat` via comptime asserts; the
dirent header is a private constant in fd.zig. Hoist it (and serialise via
an `extern struct Dirent`) for parallelism with the other wire types --
makes it easier to assert size in one place.

### [severity: nit] path.zig:298-308 -- `splitParentLeaf` strips trailing slashes silently; `expects_directory` flag from `vfs.resolve` is dropped on the floor in `path_open`'s CREAT branch

When `path = "newdir/"`, `splitParentLeaf` strips the trailing slash and
returns `parent="", leaf="newdir"`. The CREAT branch then computes
`create_dir = oflag.DIRECTORY or (path.len > 0 and path[path.len - 1] ==
'/')`, which catches the trailing-slash case and creates a directory.
Good.

But if `path = "subdir/foo/"`, splitParentLeaf returns
`parent="subdir/", leaf="foo"`, and the trailing-slash check on `path` (not
on `leaf`) still fires. So `create_dir = true`. Also good. Just worth a
one-line comment near `create_dir` saying "the test is on the original
path, not the leaf, because splitParentLeaf strips the trailing slash."

### [severity: nit] fd.zig:1-20 -- doc-comment lists eleven calls but the file actually contains the eleven plus three serialiser helpers; minor doc drift

The header comment says "Implements the eleven `fd_*` functions". Add a
parenthetical note that pure serialisers (`serializeFdstat`,
`serializeFilestat`, `serializeDirent`) and the small mapping helpers
(`vfsToWasiFiletype`, `errno`) are also exported for testability. Two-line
tweak.

## Cross-cutting observations (no action requested)

1. **Determinism is intact.** No wall clock anywhere, no host RNG, no
   `Date`/`performance`. `fd_filestat_get`/`path_filestat_get` derive
   `atim`/`mtim`/`ctim` from `state.timestamp_ms * 1_000_000` (constant
   per run). 
2. **Wire serialisers are clean.** `serializeFdstat`/`serializeFilestat`/
   `serializeDirent` zero-pad explicitly via `@memset` before writing
   fields; this guarantees deterministic bytes for the trace regardless of
   stack contents. The native unit tests (lines 534-624) cover every
   layout offset and pad zero. Strong signal.
3. **`vfs.resolve` is shared between `path_open` and `path_filestat_get`.**
   Path normalisation (NUL/absolute/length checks) lives in `normalisePath`
   and is reused by every path-* call. One obvious way.
4. **No silent error swallows in fd.zig.** Every `catch` propagates a
   typed errno via `errnoFromVfs`. The `if (preopen) NOTCAPABLE` is the
   only constant-errno return (and is wrong; see major).
5. **Cross-module consistency.** `fd_filestat_get` and `path_filestat_get`
   produce byte-identical output via the shared `serializeFilestat`. 
6. **`@bitCast` discipline for ptr ↔ i32.** `prog_mem.zig`'s `ptrToI32`
   uses bitcast (good). `path.zig` uses `@bitCast(path_ptr)` for ptr
   conversions (good). `fd.zig` uses `@intCast(out_nwritten)` for ptrs --
   slight inconsistency (will trap on > 2 GiB pointers). Same Wave-B1
   pattern; not introducing a regression. Lift to `@bitCast` for
   consistency in a later pass.

## Phase-C-specific checklist

| # | Check | Status |
|---|---|---|
| 9 | iovec entry (ptr,len) bounds-checked | **Major** -- not pre-validated; relies on host trap. Loses informative reason. |
| 10 | FD_READ / FD_WRITE rights → BADF | OK -- enforced in fd_read/fd_write. (But see the rights-vs-zone tension in the path_open major.) |
| 11 | fd_readdir cookie semantics (start=0, EOF when bytes_used < buf_len, no inversion) | OK -- correct, per decision sheet. |
| 12 | path_open oflags interactions (CREAT+EXCL+exists → EEXIST; DIRECTORY on file → NOTDIR; CREAT under /in → ENOTCAPABLE; TRUNC on read-only → silent ignore) | EEXIST/NOTDIR/TRUNC are correct. CREAT under /in returns INVAL (not NOTCAPABLE) due to the splitParentLeaf bug -- see blocker. |
| 13 | path_symlink/link/readlink errnos | Minor divergence -- universal NOTSUP/NOENT instead of zone-discriminated. Acceptable if design doc is patched to say "universal NOTSUP for v1". |
