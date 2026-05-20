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

/// Resolve `split.parent` against `start`, treating an empty parent (the
/// canonical single-leaf-name case, e.g. `creat("foo", ...)` against a dirfd)
/// as `start` itself. Without this short-circuit `normalisePath("")` would
/// return `error.Empty` -> EINVAL, breaking every CREAT-shaped call against a
/// preopen dirfd. Returns `null` and sets `out_errno` on resolve failure so
/// the caller can short-circuit with the appropriate WASI errno.
fn resolveParent(start: *vfs.Node, parent_path: []const u8, out_errno: *abi.Errno) ?*vfs.Node {
    if (parent_path.len == 0) return start;
    const r = normalisePath(start, parent_path) catch |err| {
        out_errno.* = errnoFromNormalise(err);
        return null;
    };
    return r.node;
}

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

/// Bitmask of WASI rights the node can actually serve when the FD is
/// opened on it directly. Used to clamp `rights_base` at path_open time.
/// The clamp model: rights are enforced ONLY at the shim (in the per-call
/// rights gates of fd_read/fd_write/fd_seek/etc.); OS-level enforcement is
/// N/A because the shim *is* the FS. Clamping at open means a caller that
/// requested near-max rights (wasi-libc's default) still gets a workable
/// FD, but the rights bitmap accurately reflects what the FD can do -- so
/// subsequent ops return BADF (the rights gate) on capability violations
/// instead of ROFS/ISDIR (the per-op enforcement).
pub fn nodeSupportedRights(node: *vfs.Node) u64 {
    return switch (node.vtable.kind) {
        // Read-only file: read/seek/tell/stat. No write, no fdstat-set
        // (immutable), no truncate.
        .input_file => abi.RIGHT_FD_READ | abi.RIGHT_FD_SEEK | abi.RIGHT_FD_TELL |
            abi.RIGHT_FD_FILESTAT_GET | abi.RIGHT_FD_ADVISE |
            abi.RIGHT_POLL_FD_READWRITE,
        // Write-only seekable file (record/output accumulators). The shim
        // accepts SEEK on these so wasi-libc's "rewind on close" patterns
        // work, but the in-memory writer treats out-of-order offsets as
        // INVAL -- the rights bitmap stays permissive, the node enforces.
        .output_file => abi.RIGHT_FD_WRITE | abi.RIGHT_FD_SEEK | abi.RIGHT_FD_TELL |
            abi.RIGHT_FD_FILESTAT_GET | abi.RIGHT_FD_DATASYNC |
            abi.RIGHT_FD_SYNC | abi.RIGHT_FD_ADVISE |
            abi.RIGHT_FD_FILESTAT_SET_SIZE |
            abi.RIGHT_FD_FILESTAT_SET_TIMES | abi.RIGHT_POLL_FD_READWRITE,
        // Write-only stream (/out/debug, stdio bound to debug). No seek.
        .output_stream => abi.RIGHT_FD_WRITE | abi.RIGHT_FD_FILESTAT_GET |
            abi.RIGHT_FD_DATASYNC | abi.RIGHT_FD_SYNC |
            abi.RIGHT_POLL_FD_READWRITE,
        // R/W seekable file (memfs).
        .memfs_file => abi.RIGHT_FD_READ | abi.RIGHT_FD_WRITE |
            abi.RIGHT_FD_SEEK | abi.RIGHT_FD_TELL |
            abi.RIGHT_FD_FILESTAT_GET | abi.RIGHT_FD_FILESTAT_SET_SIZE |
            abi.RIGHT_FD_FILESTAT_SET_TIMES | abi.RIGHT_FD_DATASYNC |
            abi.RIGHT_FD_SYNC | abi.RIGHT_FD_ADVISE |
            abi.RIGHT_FD_ALLOCATE | abi.RIGHT_POLL_FD_READWRITE,
        // Mutable directory: readdir + mutation rights propagated to
        // children via inheriting (the caller selects what they want; the
        // inheriting set advertises what's available).
        .memfs_directory => abi.RIGHT_FD_READDIR | abi.RIGHT_FD_FILESTAT_GET |
            abi.RIGHT_PATH_OPEN | abi.RIGHT_PATH_CREATE_DIRECTORY |
            abi.RIGHT_PATH_CREATE_FILE | abi.RIGHT_PATH_FILESTAT_GET |
            abi.RIGHT_PATH_FILESTAT_SET_SIZE |
            abi.RIGHT_PATH_FILESTAT_SET_TIMES | abi.RIGHT_PATH_REMOVE_DIRECTORY |
            abi.RIGHT_PATH_RENAME_SOURCE | abi.RIGHT_PATH_RENAME_TARGET |
            abi.RIGHT_PATH_UNLINK_FILE,
        // Read-only directory (/in, /out, /dev): readdir + path_open. No
        // mutation rights -- attempts to create/unlink under here surface
        // via the existing mutationGate.
        .static_directory => abi.RIGHT_FD_READDIR | abi.RIGHT_FD_FILESTAT_GET |
            abi.RIGHT_PATH_OPEN | abi.RIGHT_PATH_FILESTAT_GET,
        // R/W character device (/dev/null, /dev/zero, /dev/random write
        // path for wasi-libc's seed init). No seek.
        .rw_device => abi.RIGHT_FD_READ | abi.RIGHT_FD_WRITE |
            abi.RIGHT_FD_FILESTAT_GET | abi.RIGHT_POLL_FD_READWRITE,
        // Read-only character device. Currently unused (we treat
        // /dev/random as rw_device so wasi-libc seed init can write); kept
        // in the enum for completeness so a future stricter mode can
        // graduate to it.
        .ro_device => abi.RIGHT_FD_READ | abi.RIGHT_FD_FILESTAT_GET |
            abi.RIGHT_POLL_FD_READWRITE,
        // Conservative fallback for vtables that haven't opted into the
        // classification yet. Zero rights -- any subsequent fd_read/
        // fd_write returns BADF, which surfaces as a clear rights error.
        // New node implementations should declare a kind explicitly.
        .opaque_node => 0,
    };
}

/// Bitmask of WASI rights this node's *descendants* can claim. For non-
/// directories, equals `nodeSupportedRights` (vacuous -- there are no
/// descendants). For directories, this is the union of every supported-
/// rights set the directory can hand out via path_open. wasi-libc
/// computes "max child rights = dirfd's `fs_rights_inheriting`" before
/// calling path_open, so the inheriting set must be wide enough to cover
/// what the children actually support -- otherwise wasi-libc would mask
/// out (e.g.) FD_READ when opening `/in/foo` because the dirfd's
/// inheriting didn't advertise it.
pub fn nodeInheritingRights(node: *vfs.Node) u64 {
    return switch (node.vtable.kind) {
        // Directories: union of every kind of child a path_open beneath
        // them might land on. We over-approximate liberally because the
        // child's own per-call clamp (in finishOpen) restricts the actual
        // FD; advertising too-broad inheriting is harmless.
        .static_directory, .memfs_directory => allInheritableRights(),
        // Non-directories don't bear children. Use supported as the
        // inheriting set; wasi-libc never reads it for non-dirs.
        else => nodeSupportedRights(node),
    };
}

/// Compile-time union of the per-kind supported rights for every node
/// kind that can sit under a directory. Cached as a comptime constant so
/// the bitmask isn't recomputed per call.
fn allInheritableRights() u64 {
    return abi.RIGHT_FD_READ | abi.RIGHT_FD_WRITE | abi.RIGHT_FD_SEEK |
        abi.RIGHT_FD_TELL | abi.RIGHT_FD_FILESTAT_GET |
        abi.RIGHT_FD_FILESTAT_SET_SIZE | abi.RIGHT_FD_FILESTAT_SET_TIMES |
        abi.RIGHT_FD_DATASYNC | abi.RIGHT_FD_SYNC | abi.RIGHT_FD_ADVISE |
        abi.RIGHT_FD_ALLOCATE | abi.RIGHT_FD_READDIR |
        abi.RIGHT_PATH_OPEN | abi.RIGHT_PATH_CREATE_DIRECTORY |
        abi.RIGHT_PATH_CREATE_FILE | abi.RIGHT_PATH_FILESTAT_GET |
        abi.RIGHT_PATH_FILESTAT_SET_SIZE |
        abi.RIGHT_PATH_FILESTAT_SET_TIMES |
        abi.RIGHT_PATH_REMOVE_DIRECTORY | abi.RIGHT_PATH_RENAME_SOURCE |
        abi.RIGHT_PATH_RENAME_TARGET | abi.RIGHT_PATH_UNLINK_FILE |
        abi.RIGHT_POLL_FD_READWRITE;
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
    // Clamp the caller's requested rights to what this node can actually
    // serve. wasi-libc requests near-max rights as a default; without
    // clamping, the FD's rights bitmap would advertise capabilities the
    // node can't honour (e.g. FD_WRITE on a /in/* leaf), and the per-op
    // enforcement would surface a confusing ROFS/ISDIR/NotSupported error
    // mid-operation. Post-clamp, the existing fd_read/fd_write rights
    // gates produce BADF synchronously when the program asks for an
    // operation the node doesn't support.
    //
    // `rights_inheriting` is clamped against the node's *child* rights
    // (a wider union for directories) rather than its own supported set,
    // so wasi-libc's "compute child max from dirfd inheriting" pattern
    // doesn't mask out (e.g.) FD_READ when opening `/in/foo` from the
    // /in dirfd.
    const supported = nodeSupportedRights(node);
    const inheriting_supported = nodeInheritingRights(node);
    const requested_base: u64 = @bitCast(rights_base);
    const requested_inh: u64 = @bitCast(rights_inheriting);
    const idx = fd_table.alloc(.{
        .node = node,
        .offset = 0,
        .rights_base = requested_base & supported,
        .rights_inheriting = requested_inh & inheriting_supported,
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

    var parent_errno: abi.Errno = abi.Errno.SUCCESS;
    const parent = resolveParent(start, split.parent, &parent_errno) orelse
        return @intFromEnum(parent_errno);
    if (!memfs.isMemfsDir(parent)) {
        // Per design: CREAT under /in → NOTCAPABLE; CREAT into /out's virtual
        // tree never reaches here (the dual file/dir nodes exist before
        // resolution); CREAT under /dev with a missing leaf is just NOENT
        // (the device set is fixed). NOTCAPABLE is the right sentinel for
        // "you asked to create where creation isn't allowed."
        return @intFromEnum(abi.Errno.NOTCAPABLE);
    }

    // Invariant: isMemfsDir(parent) is true (just checked), so arenaOf must
    // succeed. Per AGENTS.md "never silently drop errors": panic if a
    // future memfs refactor breaks the invariant rather than masking the
    // bug as IO.
    const arena = memfs.arenaOf(parent) orelse
        @panic("memfs invariant broken: isMemfsDir(parent) but arenaOf returned null");
    const new_node = if (create_dir)
        memfs.makeDir(arena, split.leaf) orelse return @intFromEnum(abi.Errno.NOSPC)
    else
        memfs.makeFile(arena, split.leaf, null) orelse return @intFromEnum(abi.Errno.NOSPC);
    if (!memfs.addChild(parent, split.leaf, new_node)) {
        // Race-free in our single-threaded model, and we got here only
        // because resolve returned NotFound -- so AlreadyExists is
        // impossible. The only remaining failure mode is the children
        // array's bytes-allocation arena exhausting (NOSPC).
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
        // atim/mtim/ctim deliberately 0; see fd_filestat_get.
        .atim = 0,
        .mtim = 0,
        .ctim = 0,
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

    var parent_errno: abi.Errno = abi.Errno.SUCCESS;
    const parent = resolveParent(start, split.parent, &parent_errno) orelse
        return @intFromEnum(parent_errno);
    const zone_errno = mutationGate(parent);
    if (zone_errno != abi.Errno.SUCCESS) return @intFromEnum(zone_errno);

    // Invariant: mutationGate returned SUCCESS only if parent is a memfs dir,
    // so arenaOf must succeed. Per AGENTS.md "never silently drop errors": a
    // null here means a future memfs refactor broke this invariant; surface
    // it as a panic rather than an opaque IO errno.
    const arena = memfs.arenaOf(parent) orelse
        @panic("memfs invariant broken: mutationGate accepted parent but arenaOf returned null");
    const new_dir = memfs.makeDir(arena, split.leaf) orelse
        return @intFromEnum(abi.Errno.NOSPC);
    if (!memfs.addChild(parent, split.leaf, new_dir)) {
        // Either AlreadyExists (real error) or arena exhaustion mid-grow.
        // Probe the parent for the leaf to disambiguate. Switch on the lookup
        // error variant per AGENTS.md ("never silently drop errors") so a
        // future lookup that returns BadFd / NotADirectory etc. propagates
        // accurately instead of being collapsed to NOSPC.
        const lookup = parent.vtable.lookup orelse
            @panic("memfs invariant broken: parent has no lookup vtable");
        if (lookup(parent, split.leaf)) |_| {
            return @intFromEnum(abi.Errno.EXIST);
        } else |err| switch (err) {
            // NotFound here means addChild's bytes-allocation succeeded but
            // its capacity grow ran out -- map to NOSPC.
            vfs.VfsError.NotFound => return @intFromEnum(abi.Errno.NOSPC),
            else => return @intFromEnum(abi.errnoFromVfs(err)),
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

    var parent_errno: abi.Errno = abi.Errno.SUCCESS;
    const parent = resolveParent(start, split.parent, &parent_errno) orelse
        return @intFromEnum(parent_errno);
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

    var old_parent_errno: abi.Errno = abi.Errno.SUCCESS;
    const old_parent = resolveParent(old_start, old_split.parent, &old_parent_errno) orelse
        return @intFromEnum(old_parent_errno);
    var new_parent_errno: abi.Errno = abi.Errno.SUCCESS;
    const new_parent = resolveParent(new_start, new_split.parent, &new_parent_errno) orelse
        return @intFromEnum(new_parent_errno);

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
/// ENOENT. Since we never have symlinks, the universal answer matches the
/// "not a symlink" branch of the spec: EINVAL. (Earlier drafts returned
/// NOENT here, but that contradicted both the spec table and the design
/// doc's "symlinks: ENOTSUP everywhere" out-of-scope note. We pick EINVAL
/// as the spec-conformant signal that "this resolved fine but isn't a
/// link", and avoid the resolve-then-reject pass since no real program
/// calls readlink on this shim today.)
pub fn path_readlink(_: i32, _: i32, _: i32, _: i32, _: i32, _: i32) i32 {
    return @intFromEnum(abi.Errno.INVAL);
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

test "resolveParent: empty parent returns start (single-leaf-name CREAT case)" {
    // Regression test for the Phase C blocker: splitParentLeaf("foo") returns
    // parent="" leaf="foo". Without the empty-parent short-circuit, the
    // canonical creat(2)-shaped path_open(scratch_dirfd, "newfile", O_CREAT)
    // hit normalisePath("") -> error.Empty -> EINVAL, breaking every CREAT
    // / unlink / rename / mkdir / rmdir against a top-level leaf.
    var root = TestNode.dir(&.{});
    var out_errno: abi.Errno = abi.Errno.SUCCESS;
    const got = resolveParent(&root.node, "", &out_errno);
    try testing.expect(got != null);
    try testing.expect(got.? == &root.node);
    try testing.expectEqual(abi.Errno.SUCCESS, out_errno);
}

test "resolveParent: non-empty parent walks via normalisePath" {
    var leaf = TestNode.file();
    var sub = TestNode.dir(&[_]TestNode.Child{.{ .name = "leaf", .node = &leaf }});
    var root = TestNode.dir(&[_]TestNode.Child{.{ .name = "sub", .node = &sub }});
    var out_errno: abi.Errno = abi.Errno.SUCCESS;
    // Parent path "sub/" -> resolves to `sub`. (splitParentLeaf("sub/x")
    // would yield parent="sub/" leaf="x".)
    const got = resolveParent(&root.node, "sub/", &out_errno);
    try testing.expect(got != null);
    try testing.expect(got.? == &sub.node);
}

test "resolveParent: non-empty parent that fails to resolve sets errno" {
    var root = TestNode.dir(&.{});
    var out_errno: abi.Errno = abi.Errno.SUCCESS;
    // "missing" doesn't exist under root -> NotFound -> NOENT.
    const got = resolveParent(&root.node, "missing/", &out_errno);
    try testing.expect(got == null);
    try testing.expectEqual(abi.Errno.NOENT, out_errno);
}

test "splitParentLeaf single-segment input has empty parent (regression)" {
    // The Phase C blocker pivoted on splitParentLeaf returning .parent="";
    // the contract here is that the helper does NOT special-case it. The
    // fix lives in resolveParent, not in splitParentLeaf -- this test
    // documents that intent.
    const r = splitParentLeaf("foo").?;
    try testing.expectEqualStrings("", r.parent);
    try testing.expectEqualStrings("foo", r.leaf);
}

test "nodeSupportedRights: opaque vtable defaults to zero" {
    var dummy = TestNode.file(); // file_vtable has .kind = .opaque_node
    try testing.expectEqual(@as(u64, 0), nodeSupportedRights(&dummy.node));
}

test "nodeInheritingRights: directories advertise the union of child rights" {
    // Build a kind-tagged dir vtable directly (TestNode default is opaque).
    const dir_vtable: vfs.NodeVTable = .{
        .stat = TestNode.statImpl,
        .read = TestNode.readImpl,
        .write = TestNode.writeImpl,
        .close = TestNode.closeImpl,
        .readdir = null,
        .lookup = TestNode.lookupImpl,
        .kind = .static_directory,
    };
    var dir_node: vfs.Node = .{ .vtable = &dir_vtable };

    // Inheriting must include FD_READ + FD_WRITE so wasi-libc's "max
    // child rights = dirfd inheriting" pattern doesn't pre-mask either.
    const inh = nodeInheritingRights(&dir_node);
    try testing.expect((inh & abi.RIGHT_FD_READ) != 0);
    try testing.expect((inh & abi.RIGHT_FD_WRITE) != 0);
    try testing.expect((inh & abi.RIGHT_FD_SEEK) != 0);
    try testing.expect((inh & abi.RIGHT_PATH_OPEN) != 0);
}

test "nodeInheritingRights: non-directories report supported (no children)" {
    var leaf = TestNode.file();
    // file_vtable defaults to .opaque_node -> supported = 0.
    try testing.expectEqual(nodeSupportedRights(&leaf.node), nodeInheritingRights(&leaf.node));
}
