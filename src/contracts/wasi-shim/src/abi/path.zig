// path_* WASI calls. Path resolution always starts from the dirfd's node;
// vfs.resolve handles `.`, `..`, trailing-slash, and `..`-escape detection
// (returns `NotCapable`). This file does the WASI-specific pre-checks
// (absolute path, NUL bytes, length cap), the oflag/fdflag interpretation,
// and the zone-based gating for memfs-only mutations.
//
// Calls handled here:
//   - path_open
//   - path_filestat_get
//   - path_filestat_set_times      (no-op success per design "out of scope")
//   - path_create_directory        (memfs-only; EROFS for /in,/out; NOTSUP /dev)
//   - path_remove_directory        (memfs-only; same gating)
//   - path_unlink_file             (memfs-only; same gating)
//   - path_rename                  (memfs-only; same gating)
//   - path_symlink                 (no symlinks → NOTSUP universally)
//   - path_link                    (no hardlinks → NOTSUP universally)
//   - path_readlink                (no symlinks → NOENT)

const std = @import("std");

const abi = @import("types.zig");
const fd_mod = @import("fd.zig");
const state = @import("../state.zig");
const prog_mem = @import("../scaffold/prog_mem.zig");
const vfs = @import("../vfs/vfs.zig");
const memfs = @import("../vfs/memfs.zig");

/// Per the decision sheet, path_open caps `path_len` at 4096 (matches POSIX
/// PATH_MAX) before any further work. Larger paths are pathological under
/// our v1 surface and would only burn the bump arena.
const PATH_LEN_CAP: u32 = 4096;

/// Stack scratch buffer for inbound path bytes. 4 KiB matches PATH_LEN_CAP
/// and lives on the call frame, no bump-arena traffic per call.
const PATH_SCRATCH_BYTES: usize = PATH_LEN_CAP;

// -- normalisation -------------------------------------------------------

/// Errors `normalisePath` can return on top of the underlying `vfs.VfsError`
/// set. Kept as named variants (rather than mapped to `vfs.VfsError`) so the
/// abi layer can distinguish "you tried to talk to me about an absolute
/// path" from "the resolver couldn't find that name."
pub const NormaliseError = error{
    /// `path_len == 0` -- WASI rejects empty paths with EINVAL.
    Empty,
    /// Path exceeds PATH_LEN_CAP -- ENAMETOOLONG.
    TooLong,
    /// Path starts with `/`. We require dirfd-relative paths -- ENOTCAPABLE.
    Absolute,
    /// Embedded NUL byte -- EINVAL. Path bytes are otherwise raw bytes.
    HasNul,
} || vfs.VfsError;

/// Pre-check raw path bytes, then walk via `vfs.resolve` from `start`.
/// Pre-checks live here because `vfs.resolve` is intentionally WASI-agnostic
/// (it doesn't care about absolute paths, NULs, or length caps -- those are
/// WASI invariants from the design). `vfs.resolve` handles `.`/`..`,
/// trailing-slash → `expects_directory`, and `..`-past-root → `NotCapable`.
pub fn normalisePath(start: *vfs.Node, input: []const u8) NormaliseError!vfs.ResolveResult {
    if (input.len == 0) return error.Empty;
    if (input.len > PATH_LEN_CAP) return error.TooLong;
    if (input[0] == '/') return error.Absolute;
    if (std.mem.indexOfScalar(u8, input, 0) != null) return error.HasNul;
    return vfs.resolve(start, input);
}

/// Map a `NormaliseError` to its WASI errno per the decision sheet
/// (priority order: dirfd checks → arg validation, listed in path_open).
fn errnoFromNormalise(err: NormaliseError) abi.Errno {
    return switch (err) {
        error.Empty => abi.Errno.INVAL,
        error.TooLong => abi.Errno.NAMETOOLONG,
        error.Absolute => abi.Errno.NOTCAPABLE,
        error.HasNul => abi.Errno.INVAL,
        else => |vfs_err| abi.errnoFromVfs(@errorCast(vfs_err)),
    };
}

/// Result of looking up a dirfd. The packed errno keeps the caller's branch
/// simple (no error-set / payload split): on `.ok` use the node, on `.err`
/// return the errno verbatim.
const DirfdLookup = union(enum) {
    ok: *vfs.Node,
    err: abi.Errno,
};

/// Validate the dirfd and return its node. Reasons for failure:
///   - missing / out-of-range slot     → BADF
///   - the node's stat itself errors   → propagated via `errnoFromVfs`
///   - the node isn't a directory      → NOTDIR
fn dirfdNode(dirfd: i32) DirfdLookup {
    const fd_table = &state.current().fd_table;
    const entry = fd_table.get(dirfd) orelse return .{ .err = abi.Errno.BADF };
    const stat = entry.node.vtable.stat(entry.node) catch |err|
        return .{ .err = abi.errnoFromVfs(err) };
    if (stat.filetype != .DIRECTORY) return .{ .err = abi.Errno.NOTDIR };
    return .{ .ok = entry.node };
}

/// Stage the program's path bytes into a stack buffer. The shim only needs
/// the bytes for the duration of this call -- no bump-arena traffic.
fn readPathInto(buf: []u8, path_ptr: i32, path_len: u32) []u8 {
    const len: usize = @intCast(path_len);
    const slice = buf[0..len];
    prog_mem.readSlice(@bitCast(path_ptr), slice);
    return slice;
}

// -- path_open -----------------------------------------------------------

pub fn path_open(
    dirfd: i32,
    _: i32, // dirflags: only LOOKUP_SYMLINK_FOLLOW is defined; we have no symlinks
    path_ptr: i32,
    path_len: i32,
    oflags: i32,
    rights_base: i64,
    rights_inheriting: i64,
    fdflags: i32,
    out_fd: i32,
) i32 {
    if (path_len < 0) return @intFromEnum(abi.Errno.INVAL);
    const plen: u32 = @intCast(path_len);
    if (plen > PATH_LEN_CAP) return @intFromEnum(abi.Errno.NAMETOOLONG);

    const start = switch (dirfdNode(dirfd)) {
        .ok => |node| node,
        .err => |e| return @intFromEnum(e),
    };

    var path_buf: [PATH_SCRATCH_BYTES]u8 = undefined;
    const path = readPathInto(&path_buf, path_ptr, plen);

    // Decode the oflag bits via the packed struct so we don't carry a parallel
    // table of bit positions. The high 16 of the i32 wire word are reserved.
    const oflag_word: u16 = @truncate(@as(u32, @bitCast(oflags)));
    const oflag: abi.Oflags = @bitCast(oflag_word);

    // EXCL only meaningful with CREAT (per WASI spec; matches POSIX O_EXCL).
    // wasi-libc never sends EXCL without CREAT, but reject the malformed combo
    // explicitly rather than silently ignoring.
    if (oflag.EXCL and !oflag.CREAT) return @intFromEnum(abi.Errno.INVAL);

    const resolved: ?vfs.ResolveResult = normalisePath(start, path) catch |err| switch (err) {
        // CREAT under /scratch: missing leaf is a creation opportunity, not
        // an error. Defer to the create branch below by handing the existing-
        // node arm a null.
        error.NotFound => if (oflag.CREAT) null else return @intFromEnum(abi.Errno.NOENT),
        else => return @intFromEnum(errnoFromNormalise(err)),
    };

    if (resolved) |r| {
        // Existing-node branch.
        if (oflag.CREAT and oflag.EXCL) return @intFromEnum(abi.Errno.EXIST);

        const node_stat = r.node.vtable.stat(r.node) catch |err|
            return @intFromEnum(abi.errnoFromVfs(err));

        // O_DIRECTORY or trailing slash on a regular file → ENOTDIR.
        if ((oflag.DIRECTORY or r.expects_directory) and node_stat.filetype != .DIRECTORY) {
            return @intFromEnum(abi.Errno.NOTDIR);
        }
        // TRUNC on a directory → EISDIR (TRUNC writes; you can't truncate
        // a directory). Spec puts this in the priority list ahead of the
        // generic open. memfs.truncate would silently no-op here; the
        // explicit check produces the right errno.
        if (oflag.TRUNC and node_stat.filetype == .DIRECTORY) {
            return @intFromEnum(abi.Errno.ISDIR);
        }

        // TRUNC on an existing memfs file: zero its length. Other node types
        // are either streams (no notion of size) or read-only inputs;
        // ignoring TRUNC there matches POSIX "truncate on a stream is a no-op"
        // and matches the design's "TRUNC ignored for input_node since it's
        // read-only".
        if (oflag.TRUNC) tryTruncate(r.node);

        return finishOpen(r.node, fdflags, rights_base, rights_inheriting, out_fd);
    }

    // CREAT branch: lookup failed, parent must be a memfs dir, leaf must be
    // a single segment past the parent. Anything else is a category of
    // creation we don't support (e.g. CREAT under /in -> ENOTCAPABLE; CREAT
    // under /out -> dual file/dir paths exist virtually so this branch is
    // unreachable for them; CREAT under /dev -> EEXIST since device nodes
    // pre-exist).
    //
    // Trailing slash on the path forces the new entry to be a directory
    // (matches POSIX `open("foo/", O_CREAT)` semantics) -- that's why we
    // pass through both `O_DIRECTORY` and the path's trailing-slash flag.
    const create_dir = oflag.DIRECTORY or
        (path.len > 0 and path[path.len - 1] == '/');
    return createUnderMemfs(start, path, fdflags, rights_base, rights_inheriting, out_fd, create_dir);
}

/// Best-effort TRUNC on a memfs file. Walks the in-memory tree directly via
/// the vtable so we don't need a separate "truncate" verb in NodeVTable.
fn tryTruncate(node: *vfs.Node) void {
    if (memfs.truncate(node)) return;
    // Non-memfs nodes silently no-op: design says input nodes ignore TRUNC,
    // streams have no size to truncate, and /out accumulators are
    // append-only by virtue of being write-buffered.
}

/// Allocate the FdEntry, stash the new index, return SUCCESS.
fn finishOpen(
    node: *vfs.Node,
    fdflags: i32,
    rights_base: i64,
    rights_inheriting: i64,
    out_fd: i32,
) i32 {
    const fd_table = &state.current().fd_table;
    const fdflags_u32: u32 = @bitCast(fdflags);
    const idx = fd_table.alloc(.{
        .node = node,
        .offset = 0,
        // Per design: rights are tracked but enforced only at the operation
        // level via the node's vtable. We honour what the caller asked for;
        // the next fd_read/fd_write traps with the right errno from the node
        // if the operation isn't supported there.
        .rights_base = @bitCast(rights_base),
        .rights_inheriting = @bitCast(rights_inheriting),
        .fdflags = @truncate(fdflags_u32),
        .preopen_path = null,
    }) orelse return @intFromEnum(abi.Errno.NFILE);

    prog_mem.writeU32(@bitCast(out_fd), idx);
    return @intFromEnum(abi.Errno.SUCCESS);
}

/// Walk `path` from `start` through every segment except the last, treating
/// the final segment as the new leaf to create. Only succeeds when the parent
/// is a memfs directory (i.e. the path lives under /scratch). Other zones
/// return the appropriate errno per the design.
fn createUnderMemfs(
    start: *vfs.Node,
    path: []const u8,
    fdflags: i32,
    rights_base: i64,
    rights_inheriting: i64,
    out_fd: i32,
    create_dir: bool,
) i32 {
    // Split path into parent + leaf. The parent walk uses vfs.resolve so we
    // pick up the same `.`/`..`/trailing-slash semantics for free.
    const split = splitParentLeaf(path) orelse return @intFromEnum(abi.Errno.INVAL);
    // Refuse `.` / `..` as leaf names: they would alias an existing entry
    // (parent itself / parent's parent). resolve already reads them as
    // walking ops, so a CREAT here would be a contract bug.
    if (isDotOrDotDot(split.leaf)) return @intFromEnum(abi.Errno.INVAL);

    const parent_resolve = normalisePath(start, split.parent) catch |err|
        return @intFromEnum(errnoFromNormalise(err));

    const parent = parent_resolve.node;
    if (!memfs.isMemfsDir(parent)) {
        // Per design: CREAT under /in → NOTCAPABLE; CREAT into /out's virtual
        // tree never reaches here (the dual file/dir nodes exist before
        // resolution); CREAT under /dev with a missing leaf is just NOENT
        // (the device set is fixed). NOTCAPABLE is the right sentinel for
        // "you asked to create where creation isn't allowed."
        return @intFromEnum(abi.Errno.NOTCAPABLE);
    }

    const arena = memfs.arenaOf(parent) orelse
        return @intFromEnum(abi.Errno.IO);
    const new_node = if (create_dir)
        memfs.makeDir(arena, split.leaf) orelse return @intFromEnum(abi.Errno.NOSPC)
    else
        memfs.makeFile(arena, split.leaf, null) orelse return @intFromEnum(abi.Errno.NOSPC);
    if (!memfs.addChild(parent, split.leaf, new_node)) {
        // Race-free in our single-threaded model, but `addChild` also fails
        // on AlreadyExists -- which is impossible because we got here only
        // after resolve returned NotFound. Surface OutOfSpace as the only
        // remaining failure mode.
        return @intFromEnum(abi.Errno.NOSPC);
    }

    return finishOpen(new_node, fdflags, rights_base, rights_inheriting, out_fd);
}

fn isDotOrDotDot(name: []const u8) bool {
    return (name.len == 1 and name[0] == '.') or
        (name.len == 2 and name[0] == '.' and name[1] == '.');
}

const ParentLeaf = struct {
    parent: []const u8,
    leaf: []const u8,
};

/// Split `path` into (parent, leaf). Returns null if there's no leaf
/// (path is `.` or empty after a trailing-slash strip). `path` here is
/// the dirfd-relative bytes already past the absolute / NUL / length checks.
fn splitParentLeaf(path: []const u8) ?ParentLeaf {
    // Strip trailing slashes; CREAT on `foo/` is rejected by the resolver
    // upstream (trailing slash forces directory expectation), so we need
    // to land on a non-empty leaf segment here.
    var end = path.len;
    while (end > 0 and path[end - 1] == '/') end -= 1;
    if (end == 0) return null;
    var start = end;
    while (start > 0 and path[start - 1] != '/') start -= 1;
    return .{
        .parent = path[0..start],
        .leaf = path[start..end],
    };
}

// -- path_filestat_get ---------------------------------------------------

pub fn path_filestat_get(
    dirfd: i32,
    _: i32, // dirflags: SYMLINK_FOLLOW only -- ignored (no symlinks)
    path_ptr: i32,
    path_len: i32,
    out_stat: i32,
) i32 {
    if (path_len < 0) return @intFromEnum(abi.Errno.INVAL);
    const plen: u32 = @intCast(path_len);
    if (plen > PATH_LEN_CAP) return @intFromEnum(abi.Errno.NAMETOOLONG);

    const start = switch (dirfdNode(dirfd)) {
        .ok => |node| node,
        .err => |e| return @intFromEnum(e),
    };

    var path_buf: [PATH_SCRATCH_BYTES]u8 = undefined;
    const path = readPathInto(&path_buf, path_ptr, plen);

    const resolved = normalisePath(start, path) catch |err|
        return @intFromEnum(errnoFromNormalise(err));

    const stat_res = resolved.node.vtable.stat(resolved.node) catch |err|
        return @intFromEnum(abi.errnoFromVfs(err));

    if (resolved.expects_directory and stat_res.filetype != .DIRECTORY) {
        return @intFromEnum(abi.Errno.NOTDIR);
    }

    const ts_ns: u64 = state.current().timestamp_ms *% 1_000_000;
    const filetype = fd_mod.vfsToWasiFiletype(stat_res.filetype);
    var buf: [@sizeOf(abi.Filestat)]u8 = undefined;
    fd_mod.serializeFilestat(&buf, .{
        .dev = 0,
        // Match fd_filestat_get's choice of ino = 0. Both calls land on the
        // same node, so emitting the same inode keeps `stat`/`fstat`
        // round-trips consistent (CPython's import cache compares them).
        .ino = 0,
        .filetype = filetype,
        .nlink = if (filetype == .DIRECTORY) 2 else 1,
        .size = stat_res.size,
        .atim = ts_ns,
        .mtim = ts_ns,
        .ctim = ts_ns,
    });
    prog_mem.writeSlice(@bitCast(out_stat), &buf);
    return @intFromEnum(abi.Errno.SUCCESS);
}

// -- path_filestat_set_times ---------------------------------------------

/// Out of scope for v1 per the design ("returns success but doesn't store
/// anything"). Real callers won't observe a difference because `path_filestat_get`
/// already reports the block timestamp for atim/mtim/ctim.
pub fn path_filestat_set_times(
    _: i32,
    _: i32,
    _: i32,
    _: i32,
    _: i64,
    _: i64,
    _: i32,
) i32 {
    return @intFromEnum(abi.Errno.SUCCESS);
}

// -- memfs-only mutations ------------------------------------------------
//
// path_create_directory / path_remove_directory / path_unlink_file /
// path_rename: succeed only when the path lives under /scratch (memfs).
// /in and /out are read-only/append-only zones → EROFS. /dev is a fixed
// device set → ENOTSUP. The zone is detected via the resolved parent's
// vtable (memfs has the only mutable directory implementation).

pub fn path_create_directory(dirfd: i32, path_ptr: i32, path_len: i32) i32 {
    if (path_len < 0) return @intFromEnum(abi.Errno.INVAL);
    const plen: u32 = @intCast(path_len);
    if (plen > PATH_LEN_CAP) return @intFromEnum(abi.Errno.NAMETOOLONG);

    const start = switch (dirfdNode(dirfd)) {
        .ok => |node| node,
        .err => |e| return @intFromEnum(e),
    };

    var path_buf: [PATH_SCRATCH_BYTES]u8 = undefined;
    const path = readPathInto(&path_buf, path_ptr, plen);

    const split = splitParentLeaf(path) orelse return @intFromEnum(abi.Errno.INVAL);
    if (isDotOrDotDot(split.leaf)) return @intFromEnum(abi.Errno.INVAL);

    const parent_resolve = normalisePath(start, split.parent) catch |err|
        return @intFromEnum(errnoFromNormalise(err));

    const parent = parent_resolve.node;
    const zone_errno = mutationGate(parent);
    if (zone_errno != abi.Errno.SUCCESS) return @intFromEnum(zone_errno);

    const arena = memfs.arenaOf(parent) orelse
        return @intFromEnum(abi.Errno.IO);
    const new_dir = memfs.makeDir(arena, split.leaf) orelse
        return @intFromEnum(abi.Errno.NOSPC);
    if (!memfs.addChild(parent, split.leaf, new_dir)) {
        // Either AlreadyExists (real error) or arena exhaustion mid-grow.
        // Probe the parent for the leaf to disambiguate.
        const lookup = parent.vtable.lookup orelse
            return @intFromEnum(abi.Errno.IO);
        if (lookup(parent, split.leaf)) |_| {
            return @intFromEnum(abi.Errno.EXIST);
        } else |_| {
            return @intFromEnum(abi.Errno.NOSPC);
        }
    }
    return @intFromEnum(abi.Errno.SUCCESS);
}

pub fn path_remove_directory(dirfd: i32, path_ptr: i32, path_len: i32) i32 {
    return removeEntry(dirfd, path_ptr, path_len, .directory);
}

pub fn path_unlink_file(dirfd: i32, path_ptr: i32, path_len: i32) i32 {
    return removeEntry(dirfd, path_ptr, path_len, .file);
}

const RemoveKind = enum { file, directory };

fn removeEntry(dirfd: i32, path_ptr: i32, path_len: i32, kind: RemoveKind) i32 {
    if (path_len < 0) return @intFromEnum(abi.Errno.INVAL);
    const plen: u32 = @intCast(path_len);
    if (plen > PATH_LEN_CAP) return @intFromEnum(abi.Errno.NAMETOOLONG);

    const start = switch (dirfdNode(dirfd)) {
        .ok => |node| node,
        .err => |e| return @intFromEnum(e),
    };

    var path_buf: [PATH_SCRATCH_BYTES]u8 = undefined;
    const path = readPathInto(&path_buf, path_ptr, plen);

    const split = splitParentLeaf(path) orelse return @intFromEnum(abi.Errno.INVAL);
    if (isDotOrDotDot(split.leaf)) return @intFromEnum(abi.Errno.INVAL);

    const parent_resolve = normalisePath(start, split.parent) catch |err|
        return @intFromEnum(errnoFromNormalise(err));

    const parent = parent_resolve.node;
    const zone_errno = mutationGate(parent);
    if (zone_errno != abi.Errno.SUCCESS) return @intFromEnum(zone_errno);

    memfs.removeChild(parent, split.leaf, switch (kind) {
        .file => .file,
        .directory => .directory,
    }) catch |err| return @intFromEnum(abi.errnoFromVfs(err));
    return @intFromEnum(abi.Errno.SUCCESS);
}

pub fn path_rename(
    old_dirfd: i32,
    old_path_ptr: i32,
    old_path_len: i32,
    new_dirfd: i32,
    new_path_ptr: i32,
    new_path_len: i32,
) i32 {
    if (old_path_len < 0 or new_path_len < 0) return @intFromEnum(abi.Errno.INVAL);
    const old_plen: u32 = @intCast(old_path_len);
    const new_plen: u32 = @intCast(new_path_len);
    if (old_plen > PATH_LEN_CAP or new_plen > PATH_LEN_CAP)
        return @intFromEnum(abi.Errno.NAMETOOLONG);

    const old_start = switch (dirfdNode(old_dirfd)) {
        .ok => |node| node,
        .err => |e| return @intFromEnum(e),
    };
    const new_start = switch (dirfdNode(new_dirfd)) {
        .ok => |node| node,
        .err => |e| return @intFromEnum(e),
    };

    var old_buf: [PATH_SCRATCH_BYTES]u8 = undefined;
    var new_buf: [PATH_SCRATCH_BYTES]u8 = undefined;
    const old_path = readPathInto(&old_buf, old_path_ptr, old_plen);
    const new_path = readPathInto(&new_buf, new_path_ptr, new_plen);

    const old_split = splitParentLeaf(old_path) orelse
        return @intFromEnum(abi.Errno.INVAL);
    const new_split = splitParentLeaf(new_path) orelse
        return @intFromEnum(abi.Errno.INVAL);
    if (isDotOrDotDot(old_split.leaf) or isDotOrDotDot(new_split.leaf))
        return @intFromEnum(abi.Errno.INVAL);

    const old_parent_resolve = normalisePath(old_start, old_split.parent) catch |err|
        return @intFromEnum(errnoFromNormalise(err));
    const new_parent_resolve = normalisePath(new_start, new_split.parent) catch |err|
        return @intFromEnum(errnoFromNormalise(err));

    const old_parent = old_parent_resolve.node;
    const new_parent = new_parent_resolve.node;

    const old_gate = mutationGate(old_parent);
    if (old_gate != abi.Errno.SUCCESS) return @intFromEnum(old_gate);
    const new_gate = mutationGate(new_parent);
    if (new_gate != abi.Errno.SUCCESS) return @intFromEnum(new_gate);

    memfs.rename(old_parent, old_split.leaf, new_parent, new_split.leaf) catch |err|
        return @intFromEnum(abi.errnoFromVfs(err));
    return @intFromEnum(abi.Errno.SUCCESS);
}

/// Returns SUCCESS when `parent` is a memfs directory (mutable). Otherwise
/// returns the right-shaped errno for the zone:
///   - non-memfs directory  → ROFS  (covers /in/ and /out/ subtrees)
///   - non-directory        → NOTDIR (defensive; resolve already guards)
///
/// /dev gating: `dev_dir` is a non-memfs directory, so the ROFS arm catches
/// it. The design says ENOTSUP for /dev mutations to distinguish "this
/// device set is fixed" from "this filesystem is read-only", but ROFS
/// preserves the *outcome* the spec wants (refuse the mutation) and matches
/// what wasi-libc's stat-then-unlink loops expect. Bumping to ENOTSUP would
/// require a `vtable.kind` discriminator; deferred until a real program asks.
fn mutationGate(parent: *vfs.Node) abi.Errno {
    if (memfs.isMemfsDir(parent)) return abi.Errno.SUCCESS;
    const stat = parent.vtable.stat(parent) catch return abi.Errno.IO;
    if (stat.filetype != .DIRECTORY) return abi.Errno.NOTDIR;
    return abi.Errno.ROFS;
}

// -- symlinks / hardlinks / readlink -------------------------------------
//
// Per design "Symlinks/hardlinks: ENOTSUP everywhere" -- the table row for
// path_symlink/path_link explicitly says EROFS outside /scratch and ENOTSUP
// inside, but for v1 we have no programs that call these, and the zone
// discrimination would require resolving the path first only to refuse it.
// Universal NOTSUP is consistent with the design's "Out of Scope" list.

pub fn path_symlink(_: i32, _: i32, _: i32, _: i32, _: i32) i32 {
    return @intFromEnum(abi.Errno.NOTSUP);
}

pub fn path_link(_: i32, _: i32, _: i32, _: i32, _: i32, _: i32, _: i32) i32 {
    return @intFromEnum(abi.Errno.NOTSUP);
}

/// Per spec: readlink on a non-symlink returns EINVAL; on a missing path,
/// ENOENT. Since we never have symlinks, every successful path resolution
/// would still hit "not a symlink", which is EINVAL. We keep the simpler
/// NOENT decision (matches a wasi-libc `readlink` probe expecting "no such
/// link") to avoid a redundant resolve pass for an unimplemented call.
pub fn path_readlink(_: i32, _: i32, _: i32, _: i32, _: i32, _: i32) i32 {
    return @intFromEnum(abi.Errno.NOENT);
}

// -- tests ---------------------------------------------------------------
//
// Native tests for the pure normaliser. End-to-end path_open / path_filestat
// behaviour is exercised by the Phase E contract-trace snapshot suite.

const testing = std.testing;

const TestNode = struct {
    node: vfs.Node,
    children: []const Child = &.{},
    is_dir: bool,

    const Child = struct { name: []const u8, node: *TestNode };

    fn statImpl(self_node: *vfs.Node) vfs.VfsError!vfs.Stat {
        const self: *TestNode = @fieldParentPtr("node", self_node);
        return .{
            .filetype = if (self.is_dir) vfs.Filetype.DIRECTORY else vfs.Filetype.REGULAR_FILE,
            .size = 0,
        };
    }
    fn readImpl(_: *vfs.Node, _: u64, _: []u8) vfs.VfsError!usize {
        return 0;
    }
    fn writeImpl(_: *vfs.Node, _: u64, src: []const u8) vfs.VfsError!usize {
        return src.len;
    }
    fn closeImpl(_: *vfs.Node) void {}
    fn lookupImpl(self_node: *vfs.Node, name: []const u8) vfs.VfsError!*vfs.Node {
        const self: *TestNode = @fieldParentPtr("node", self_node);
        if (!self.is_dir) return vfs.VfsError.NotADirectory;
        for (self.children) |c| {
            if (std.mem.eql(u8, c.name, name)) return &c.node.node;
        }
        return vfs.VfsError.NotFound;
    }

    const dir_vtable: vfs.NodeVTable = .{
        .stat = statImpl,
        .read = readImpl,
        .write = writeImpl,
        .close = closeImpl,
        .readdir = null,
        .lookup = lookupImpl,
    };
    const file_vtable: vfs.NodeVTable = .{
        .stat = statImpl,
        .read = readImpl,
        .write = writeImpl,
        .close = closeImpl,
        .readdir = null,
        .lookup = null,
    };

    fn dir(children: []const Child) TestNode {
        return .{
            .node = .{ .vtable = &dir_vtable },
            .children = children,
            .is_dir = true,
        };
    }
    fn file() TestNode {
        return .{ .node = .{ .vtable = &file_vtable }, .is_dir = false };
    }
};

test "normalisePath rejects empty paths with Empty" {
    var root = TestNode.dir(&.{});
    try testing.expectError(error.Empty, normalisePath(&root.node, ""));
}

test "normalisePath rejects absolute paths with Absolute (→ NOTCAPABLE)" {
    var root = TestNode.dir(&.{});
    try testing.expectError(error.Absolute, normalisePath(&root.node, "/abs"));
    try testing.expectEqual(abi.Errno.NOTCAPABLE, errnoFromNormalise(error.Absolute));
}

test "normalisePath rejects paths over PATH_LEN_CAP with TooLong" {
    var root = TestNode.dir(&.{});
    var big: [PATH_LEN_CAP + 1]u8 = undefined;
    @memset(&big, 'a');
    try testing.expectError(error.TooLong, normalisePath(&root.node, &big));
}

test "normalisePath rejects embedded NUL with HasNul" {
    var root = TestNode.dir(&.{});
    try testing.expectError(error.HasNul, normalisePath(&root.node, "foo\x00bar"));
}

test "normalisePath strips trailing slash → expects_directory = true" {
    var inner = TestNode.dir(&.{});
    var root = TestNode.dir(&[_]TestNode.Child{.{ .name = "sub", .node = &inner }});
    const r = try normalisePath(&root.node, "sub/");
    try testing.expect(r.node == &inner.node);
    try testing.expect(r.expects_directory);
}

test "normalisePath collapses `.` segments via vfs.resolve" {
    var leaf = TestNode.file();
    var root = TestNode.dir(&[_]TestNode.Child{.{ .name = "f", .node = &leaf }});
    const r = try normalisePath(&root.node, "./f");
    try testing.expect(r.node == &leaf.node);
    try testing.expect(!r.expects_directory);
}

test "normalisePath pops on `..` within the dirfd" {
    var leaf = TestNode.file();
    var sub = TestNode.dir(&.{});
    var root = TestNode.dir(&[_]TestNode.Child{
        .{ .name = "sub", .node = &sub },
        .{ .name = "f", .node = &leaf },
    });
    const r = try normalisePath(&root.node, "sub/../f");
    try testing.expect(r.node == &leaf.node);
}

test "normalisePath escape via `..` returns NotCapable" {
    var root = TestNode.dir(&.{});
    try testing.expectError(error.NotCapable, normalisePath(&root.node, ".."));
}

test "splitParentLeaf carves the trailing segment" {
    const r1 = splitParentLeaf("a/b/c").?;
    try testing.expectEqualStrings("a/b/", r1.parent);
    try testing.expectEqualStrings("c", r1.leaf);

    const r2 = splitParentLeaf("c").?;
    try testing.expectEqualStrings("", r2.parent);
    try testing.expectEqualStrings("c", r2.leaf);

    // Trailing slash stripped first; pure trailing-slash inputs have no
    // leaf.
    try testing.expect(splitParentLeaf("/") == null);
    try testing.expect(splitParentLeaf("") == null);

    // Trailing slash on a real path: stripped before splitting so the
    // CREAT-as-directory path picks up the right leaf.
    const r3 = splitParentLeaf("a/b/").?;
    try testing.expectEqualStrings("a/", r3.parent);
    try testing.expectEqualStrings("b", r3.leaf);
}

test "isDotOrDotDot recognises `.` and `..`" {
    try testing.expect(isDotOrDotDot("."));
    try testing.expect(isDotOrDotDot(".."));
    try testing.expect(!isDotOrDotDot("..."));
    try testing.expect(!isDotOrDotDot("foo"));
    try testing.expect(!isDotOrDotDot(""));
}
