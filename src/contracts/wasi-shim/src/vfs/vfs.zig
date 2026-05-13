// Core vocabulary for the shim's virtual filesystem.
//
// Intentionally WASI-agnostic and scaffold-agnostic: this file knows nothing
// about errno numbering or `scaffold_env.*`. Backing implementations
// (memfs/devfs/input_node) live in sibling files and embed `Node` as their
// first field; vtables recover the implementation via `@fieldParentPtr`.
// The abi layer translates `VfsError` to WASI errno.

const std = @import("std");

pub const VfsError = error{
    NotFound,
    NotADirectory,
    IsADirectory,
    AlreadyExists,
    NotEmpty,
    NotCapable,
    NotSupported,
    NameTooLong,
    InvalidArgument,
    BadFd,
    ReadOnly,
    EndOfFile,
    /// Backing arena (memfs bump arena, etc.) ran out of space. Distinct
    /// from `NotCapable` so the abi layer can map it to ENOSPC instead of
    /// ENOTCAPABLE.
    OutOfSpace,
};

/// Mirrors WASI snapshot preview 1 filetype numbering. Kept as an opaque
/// enum here so vfs has no dependency on the abi layer.
pub const Filetype = enum(u8) {
    UNKNOWN = 0,
    BLOCK_DEVICE = 1,
    CHARACTER_DEVICE = 2,
    DIRECTORY = 3,
    REGULAR_FILE = 4,
    SYMBOLIC_LINK = 7,
};

pub const Stat = struct {
    filetype: Filetype,
    size: u64,
};

pub const DirEntry = struct {
    name: []const u8,
    filetype: Filetype,
};

/// Coarse classification used by `path_open` to derive which WASI rights
/// the underlying node can actually serve. The abi layer clamps the
/// caller's requested rights against this set so subsequent fd_read/
/// fd_write calls return BADF (the rights gate) instead of ROFS/ISDIR
/// (the per-call enforcement). Each implementation declares its kind on
/// its vtable; the `opaque_node` default is conservative (no R/W rights
/// implied) for vtables added before this field existed.
pub const NodeKind = enum {
    /// Default for vtables that haven't opted into classification yet.
    /// Treated as zero supported rights (most restrictive); any fd_read /
    /// fd_write probe will then return BADF.
    opaque_node,
    /// Read-only file (e.g. /in/* leaves, fetch accumulators). FD_READ +
    /// FD_SEEK + FD_TELL + FD_FILESTAT_GET.
    input_file,
    /// Write-only file (/out/record/*, /out/output/*). FD_WRITE +
    /// FD_FILESTAT_GET. Notably no FD_SEEK -- /out is append-only.
    output_file,
    /// Write-only character stream (/out/debug, stdio bound to debug).
    /// FD_WRITE + FD_FILESTAT_GET. No SEEK, no READ.
    output_stream,
    /// Read+write seekable file (/scratch/* memfs). FD_READ + FD_WRITE +
    /// FD_SEEK + FD_TELL + FD_FILESTAT_GET + truncation/filestat-set.
    memfs_file,
    /// Mutable directory (/scratch). FD_READDIR + FD_FILESTAT_GET +
    /// PATH_* mutation rights. No R/W.
    memfs_directory,
    /// Read-only directory (/in, /out, /dev and their static subdirs).
    /// FD_READDIR + FD_FILESTAT_GET. No mutation rights.
    static_directory,
    /// Read+write character device (/dev/null, /dev/zero). FD_READ +
    /// FD_WRITE + FD_FILESTAT_GET. No SEEK.
    rw_device,
    /// Read-only character device (/dev/random, /dev/urandom). FD_READ +
    /// FD_FILESTAT_GET. No SEEK, no WRITE.
    ro_device,
};

pub const NodeVTable = struct {
    stat: *const fn (self: *Node) VfsError!Stat,
    /// Read into `out` from `offset`. Streams ignore `offset`; a short
    /// return (less than `out.len`) signals partial read or EOF.
    read: *const fn (self: *Node, offset: u64, out: []u8) VfsError!usize,
    /// Position-or-append write. Returns bytes written.
    write: *const fn (self: *Node, offset: u64, src: []const u8) VfsError!usize,
    /// Called once when the FD referencing this node is dropped. Memfs
    /// `/out/record/*` nodes use this to fire `emit_output`.
    close: *const fn (self: *Node) void,
    /// Directory-only: list children starting at `cookie`. Implementations
    /// own the cookie semantics (matching `fd_readdir`).
    readdir: ?*const fn (self: *Node, cookie: u64, out: []DirEntry) VfsError!usize,
    /// Directory-only: lookup a single child segment (no slashes).
    lookup: ?*const fn (self: *Node, name: []const u8) VfsError!*Node,
    /// Coarse classification used by `path_open` to clamp WASI rights.
    /// Defaults to `opaque_node` (zero rights) so older vtables remain
    /// safe; new vtables should declare an explicit kind.
    kind: NodeKind = .opaque_node,
};

pub const Node = struct {
    vtable: *const NodeVTable,
};

pub const FdEntry = struct {
    node: *Node,
    offset: u64,
    rights_base: u64,
    rights_inheriting: u64,
    fdflags: u16,
    /// Set on FDs minted from a `wasi_setup` preopen so `fd_prestat_get`
    /// can report the path. Owned by whoever populated the entry.
    preopen_path: ?[]const u8,
};

pub const FdTable = struct {
    /// Cap sized for wasi-libc workloads: typical CPython processes peak
    /// around ~64 fds during stdlib walks; QuickJS opens an order of
    /// magnitude fewer. 256 covers both with headroom and keeps the BSS
    /// footprint small (256 × sizeof(?FdEntry) ≈ 16 KiB).
    pub const MAX_FDS: u32 = 256;

    entries: [MAX_FDS]?FdEntry,
    /// LIFO stack of available slot indices. Initialised in descending order
    /// so the first `alloc` returns slot 0; matches POSIX expectations.
    free_list: [MAX_FDS]u32,
    free_count: u32,

    pub fn init() FdTable {
        var self: FdTable = .{
            .entries = [_]?FdEntry{null} ** MAX_FDS,
            .free_list = undefined,
            .free_count = MAX_FDS,
        };
        var i: u32 = 0;
        while (i < MAX_FDS) : (i += 1) {
            self.free_list[i] = MAX_FDS - 1 - i;
        }
        return self;
    }

    /// Hot-path lookup. `null` on bad/unset fd; the abi layer translates
    /// to `Errno.BADF`. Mutations (`free`) signal failure via a typed
    /// return -- the asymmetry is deliberate: lookup is read-only and may
    /// legitimately probe arbitrary fds, but every mutation is a programmer
    /// or program error worth surfacing.
    pub fn get(self: *FdTable, fd: i32) ?*FdEntry {
        if (fd < 0) return null;
        const idx: u32 = @intCast(fd);
        if (idx >= MAX_FDS) return null;
        if (self.entries[idx]) |*entry| return entry;
        return null;
    }

    pub fn alloc(self: *FdTable, entry: FdEntry) ?u32 {
        if (self.free_count == 0) return null;
        self.free_count -= 1;
        const idx = self.free_list[self.free_count];
        self.entries[idx] = entry;
        return idx;
    }

    /// Drop the slot for `fd`. Returns `BadFd` for out-of-range or
    /// already-free fds so the abi layer can return `Errno.BADF` rather
    /// than silently masking a double-close.
    pub fn free(self: *FdTable, fd: u32) VfsError!void {
        if (fd >= MAX_FDS) return VfsError.BadFd;
        if (self.entries[fd] == null) return VfsError.BadFd;
        self.entries[fd] = null;
        self.free_list[self.free_count] = fd;
        self.free_count += 1;
    }
};

pub const ResolveResult = struct {
    node: *Node,
    /// True when the input path ended in `/`; callers gate `expects directory`
    /// errors on this (e.g. trailing-slash-on-regular-file → `NotADirectory`).
    expects_directory: bool,
};

/// Maximum path nesting depth `resolve` will walk. WASI paths above this
/// return `NameTooLong`. 64 covers anything realistic; the limit exists so
/// the resolver stack lives on the C-stack, not the heap.
pub const MAX_DEPTH: u32 = 64;

/// Walk `path` from `start`. Refuses to escape `start` via `..`. Empty
/// segments collapse (so `//a` and `/a` resolve identically). Path bytes
/// are not validated as UTF-8 -- WASI passes raw bytes through.
pub fn resolve(start: *Node, path: []const u8) VfsError!ResolveResult {
    var stack: [MAX_DEPTH]*Node = undefined;
    var depth: u32 = 0;
    var i: usize = 0;
    var trailing_slash = false;

    while (i < path.len) {
        while (i < path.len and path[i] == '/') : (i += 1) {}
        if (i == path.len) {
            trailing_slash = true;
            break;
        }
        const seg_start = i;
        while (i < path.len and path[i] != '/') : (i += 1) {}
        const seg = path[seg_start..i];

        if (seg.len == 1 and seg[0] == '.') continue;
        if (seg.len == 2 and seg[0] == '.' and seg[1] == '.') {
            if (depth == 0) return VfsError.NotCapable;
            depth -= 1;
            continue;
        }

        if (depth == MAX_DEPTH) return VfsError.NameTooLong;
        const current = if (depth == 0) start else stack[depth - 1];
        const lookup = current.vtable.lookup orelse return VfsError.NotADirectory;
        stack[depth] = try lookup(current, seg);
        depth += 1;
    }

    const node = if (depth == 0) start else stack[depth - 1];
    return .{ .node = node, .expects_directory = trailing_slash };
}

// -- tests -----------------------------------------------------------------
//
// Native-target unit tests. Run via `zig test src/contracts/wasi-shim/src/vfs/vfs.zig`.
// Stdio occupies fds 0/1/2 in production, but these tests start from a pristine
// table and let `alloc` hand out 0,1,2,... so the LIFO behaviour is easy to
// observe in isolation.

const testing = std.testing;

const TestNode = struct {
    node: Node,
    name: []const u8,
    children: []const *TestNode = &.{},
    is_dir: bool,

    fn statImpl(self: *Node) VfsError!Stat {
        const tn: *TestNode = @fieldParentPtr("node", self);
        return .{
            .filetype = if (tn.is_dir) Filetype.DIRECTORY else Filetype.REGULAR_FILE,
            .size = 0,
        };
    }
    fn readImpl(_: *Node, _: u64, _: []u8) VfsError!usize {
        return 0;
    }
    fn writeImpl(_: *Node, _: u64, src: []const u8) VfsError!usize {
        return src.len;
    }
    fn closeImpl(_: *Node) void {}
    fn readdirImpl(_: *Node, _: u64, _: []DirEntry) VfsError!usize {
        return 0;
    }
    fn lookupImpl(self: *Node, name: []const u8) VfsError!*Node {
        const tn: *TestNode = @fieldParentPtr("node", self);
        if (!tn.is_dir) return VfsError.NotADirectory;
        for (tn.children) |child| {
            if (std.mem.eql(u8, child.name, name)) return &child.node;
        }
        return VfsError.NotFound;
    }

    const dir_vtable: NodeVTable = .{
        .stat = statImpl,
        .read = readImpl,
        .write = writeImpl,
        .close = closeImpl,
        .readdir = readdirImpl,
        .lookup = lookupImpl,
    };
    const file_vtable: NodeVTable = .{
        .stat = statImpl,
        .read = readImpl,
        .write = writeImpl,
        .close = closeImpl,
        .readdir = null,
        .lookup = null,
    };

    fn dir(name: []const u8, children: []const *TestNode) TestNode {
        return .{
            .node = .{ .vtable = &dir_vtable },
            .name = name,
            .children = children,
            .is_dir = true,
        };
    }
    fn file(name: []const u8) TestNode {
        return .{
            .node = .{ .vtable = &file_vtable },
            .name = name,
            .is_dir = false,
        };
    }
};

test "FdTable allocates 0 first, then 1, LIFO on free" {
    var table = FdTable.init();
    const stub_vtable: NodeVTable = .{
        .stat = TestNode.statImpl,
        .read = TestNode.readImpl,
        .write = TestNode.writeImpl,
        .close = TestNode.closeImpl,
        .readdir = null,
        .lookup = null,
    };
    var stub_node: Node = .{ .vtable = &stub_vtable };
    const entry: FdEntry = .{
        .node = &stub_node,
        .offset = 0,
        .rights_base = 0,
        .rights_inheriting = 0,
        .fdflags = 0,
        .preopen_path = null,
    };

    try testing.expectEqual(@as(?u32, 0), table.alloc(entry));
    try testing.expectEqual(@as(?u32, 1), table.alloc(entry));
    try testing.expectEqual(@as(?u32, 2), table.alloc(entry));

    try table.free(1);
    try testing.expectEqual(@as(?u32, 1), table.alloc(entry));

    try table.free(0);
    try table.free(2);
    // LIFO: last freed comes back first.
    try testing.expectEqual(@as(?u32, 2), table.alloc(entry));
    try testing.expectEqual(@as(?u32, 0), table.alloc(entry));
}

test "FdTable.get rejects out-of-range and unset slots" {
    var table = FdTable.init();
    try testing.expect(table.get(-1) == null);
    try testing.expect(table.get(0) == null);
    try testing.expect(table.get(@as(i32, @intCast(FdTable.MAX_FDS))) == null);
}

test "FdTable.free returns BadFd for out-of-range and double-free" {
    var table = FdTable.init();
    const stub_vtable: NodeVTable = .{
        .stat = TestNode.statImpl,
        .read = TestNode.readImpl,
        .write = TestNode.writeImpl,
        .close = TestNode.closeImpl,
        .readdir = null,
        .lookup = null,
    };
    var stub_node: Node = .{ .vtable = &stub_vtable };
    const entry: FdEntry = .{
        .node = &stub_node,
        .offset = 0,
        .rights_base = 0,
        .rights_inheriting = 0,
        .fdflags = 0,
        .preopen_path = null,
    };

    try testing.expectError(VfsError.BadFd, table.free(0));
    try testing.expectError(VfsError.BadFd, table.free(FdTable.MAX_FDS));
    try testing.expectError(VfsError.BadFd, table.free(FdTable.MAX_FDS + 100));

    _ = table.alloc(entry);
    try table.free(0);
    try testing.expectError(VfsError.BadFd, table.free(0));
}

test "resolve walks /a/b/c across an in-memory tree" {
    var c = TestNode.file("c");
    var b_children = [_]*TestNode{&c};
    var b = TestNode.dir("b", &b_children);
    var a_children = [_]*TestNode{&b};
    var a = TestNode.dir("a", &a_children);
    var root_children = [_]*TestNode{&a};
    var root = TestNode.dir("/", &root_children);

    const r = try resolve(&root.node, "/a/b/c");
    try testing.expect(r.node == &c.node);
    try testing.expect(!r.expects_directory);
}

test "resolve handles /a/../b" {
    var b = TestNode.file("b");
    var a = TestNode.dir("a", &.{});
    var root_children = [_]*TestNode{ &a, &b };
    var root = TestNode.dir("/", &root_children);

    const r = try resolve(&root.node, "/a/../b");
    try testing.expect(r.node == &b.node);
}

test "resolve sets expects_directory on trailing slash" {
    var a = TestNode.dir("a", &.{});
    var root_children = [_]*TestNode{&a};
    var root = TestNode.dir("/", &root_children);

    const r = try resolve(&root.node, "/a/");
    try testing.expect(r.node == &a.node);
    try testing.expect(r.expects_directory);
}

test "resolve refuses to escape start with /.." {
    var root = TestNode.dir("/", &.{});
    try testing.expectError(VfsError.NotCapable, resolve(&root.node, "/.."));
}
