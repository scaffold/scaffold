// memfs -- in-memory tree backing /scratch and /out/record/* write-buffer.

const std = @import("std");
const vfs = @import("vfs.zig");

/// Bump arena. Caller owns the underlying byte buffer (typically carved from
/// main.zig's per-run bump arena). No free; the whole arena is dropped at
/// run end. Re-bumps for grow ops leak the old slice -- that's fine because
/// the leak only lasts until the run ends.
pub const MemfsArena = struct {
    buf: []u8,
    pos: usize,

    pub fn init(buf: []u8) MemfsArena {
        return .{ .buf = buf, .pos = 0 };
    }

    pub fn alloc(self: *MemfsArena, n: usize, align_to: usize) ?[]u8 {
        const base = @intFromPtr(self.buf.ptr) + self.pos;
        const aligned = std.mem.alignForward(usize, base, align_to);
        const start = aligned - @intFromPtr(self.buf.ptr);
        const end = start + n;
        if (end > self.buf.len) return null;
        self.pos = end;
        return self.buf[start..end];
    }

    fn create(self: *MemfsArena, comptime T: type) ?*T {
        const slice = self.alloc(@sizeOf(T), @alignOf(T)) orelse return null;
        return @ptrCast(@alignCast(slice.ptr));
    }

    fn dupe(self: *MemfsArena, bytes: []const u8) ?[]u8 {
        const slice = self.alloc(bytes.len, 1) orelse return null;
        @memcpy(slice, bytes);
        return slice;
    }
};

pub const OnCloseFn = *const fn (ctx: ?*anyopaque, name: []const u8, bytes: []const u8) void;

pub const OnClose = struct {
    fn_: OnCloseFn,
    ctx: ?*anyopaque,
};

const ChildEntry = struct {
    name: []const u8,
    node: *vfs.Node,
};

const MemfsDir = struct {
    node: vfs.Node,
    arena: *MemfsArena,
    name: []const u8,
    children: []ChildEntry,
    capacity: usize,
    len: usize,

    const vtable: vfs.NodeVTable = .{
        .stat = stat,
        .read = read,
        .write = write,
        .close = close,
        .readdir = readdir,
        .lookup = lookup,
    };

    fn stat(self: *vfs.Node) vfs.VfsError!vfs.Stat {
        const dir: *MemfsDir = @fieldParentPtr("node", self);
        return .{ .filetype = .DIRECTORY, .size = dir.len };
    }

    fn read(_: *vfs.Node, _: u64, _: []u8) vfs.VfsError!usize {
        return vfs.VfsError.IsADirectory;
    }

    fn write(_: *vfs.Node, _: u64, _: []const u8) vfs.VfsError!usize {
        return vfs.VfsError.IsADirectory;
    }

    fn close(_: *vfs.Node) void {}

    fn readdir(self: *vfs.Node, cookie: u64, out: []vfs.DirEntry) vfs.VfsError!usize {
        const dir: *MemfsDir = @fieldParentPtr("node", self);
        if (cookie >= dir.len) return 0;
        const start: usize = @intCast(cookie);
        const remaining = dir.len - start;
        const n = @min(remaining, out.len);
        var i: usize = 0;
        while (i < n) : (i += 1) {
            const child = dir.children[start + i];
            const ft: vfs.Filetype = if (child.node.vtable == &MemfsDir.vtable)
                .DIRECTORY
            else
                .REGULAR_FILE;
            out[i] = .{ .name = child.name, .filetype = ft };
        }
        return n;
    }

    fn lookup(self: *vfs.Node, name: []const u8) vfs.VfsError!*vfs.Node {
        const dir: *MemfsDir = @fieldParentPtr("node", self);
        var i: usize = 0;
        while (i < dir.len) : (i += 1) {
            if (std.mem.eql(u8, dir.children[i].name, name)) return dir.children[i].node;
        }
        return vfs.VfsError.NotFound;
    }
};

const MemfsFile = struct {
    node: vfs.Node,
    arena: *MemfsArena,
    name: []const u8,
    bytes: []u8,
    capacity: usize,
    len: usize,
    on_close: ?OnClose,

    const vtable: vfs.NodeVTable = .{
        .stat = stat,
        .read = read,
        .write = write,
        .close = close,
        .readdir = null,
        .lookup = null,
    };

    fn stat(self: *vfs.Node) vfs.VfsError!vfs.Stat {
        const file: *MemfsFile = @fieldParentPtr("node", self);
        return .{ .filetype = .REGULAR_FILE, .size = file.len };
    }

    fn read(self: *vfs.Node, offset: u64, out: []u8) vfs.VfsError!usize {
        const file: *MemfsFile = @fieldParentPtr("node", self);
        // Past-EOF reads return 0 (POSIX EOF), not an error.
        if (offset >= file.len) return 0;
        const start: usize = @intCast(offset);
        const available = file.len - start;
        const n = @min(available, out.len);
        @memcpy(out[0..n], file.bytes[start .. start + n]);
        return n;
    }

    fn write(self: *vfs.Node, offset: u64, src: []const u8) vfs.VfsError!usize {
        const file: *MemfsFile = @fieldParentPtr("node", self);
        // Reject hole-writes after EOF -- design forbids sparse files in memfs.
        if (offset > file.len) return vfs.VfsError.InvalidArgument;
        const start: usize = @intCast(offset);
        const end = start + src.len;
        if (end > file.capacity) {
            const new_cap = growCapacity(file.capacity, end);
            const new_buf = file.arena.alloc(new_cap, 1) orelse
                return vfs.VfsError.NotCapable;
            @memcpy(new_buf[0..file.len], file.bytes[0..file.len]);
            file.bytes = new_buf;
            file.capacity = new_cap;
        }
        @memcpy(file.bytes[start..end], src);
        if (end > file.len) file.len = end;
        return src.len;
    }

    fn close(self: *vfs.Node) void {
        const file: *MemfsFile = @fieldParentPtr("node", self);
        // Single-fire: null the closure so a second close is a no-op.
        if (file.on_close) |hook| {
            file.on_close = null;
            hook.fn_(hook.ctx, file.name, file.bytes[0..file.len]);
        }
    }
};

fn growCapacity(current: usize, needed: usize) usize {
    var cap: usize = if (current == 0) 16 else current;
    while (cap < needed) cap *= 2;
    return cap;
}

pub fn makeDir(arena: *MemfsArena, name: []const u8) ?*vfs.Node {
    const dir = arena.create(MemfsDir) orelse return null;
    const name_copy = arena.dupe(name) orelse return null;
    dir.* = .{
        .node = .{ .vtable = &MemfsDir.vtable },
        .arena = arena,
        .name = name_copy,
        .children = &.{},
        .capacity = 0,
        .len = 0,
    };
    return &dir.node;
}

pub fn makeFile(arena: *MemfsArena, name: []const u8, on_close: ?OnClose) ?*vfs.Node {
    const file = arena.create(MemfsFile) orelse return null;
    const name_copy = arena.dupe(name) orelse return null;
    file.* = .{
        .node = .{ .vtable = &MemfsFile.vtable },
        .arena = arena,
        .name = name_copy,
        .bytes = &.{},
        .capacity = 0,
        .len = 0,
        .on_close = on_close,
    };
    return &file.node;
}

/// Add `child` (already a vfs.Node from `makeDir`/`makeFile`) to `parent`.
/// Returns false on AlreadyExists or arena exhaustion. Higher layers (path
/// open/create) own the create-vs-open semantics; memfs just tracks names.
pub fn addChild(parent: *vfs.Node, child_name: []const u8, child: *vfs.Node) bool {
    if (parent.vtable != &MemfsDir.vtable) return false;
    const dir: *MemfsDir = @fieldParentPtr("node", parent);
    var i: usize = 0;
    while (i < dir.len) : (i += 1) {
        if (std.mem.eql(u8, dir.children[i].name, child_name)) return false;
    }
    if (dir.len == dir.capacity) {
        const new_cap = growCapacity(dir.capacity, dir.len + 1);
        const bytes = dir.arena.alloc(
            new_cap * @sizeOf(ChildEntry),
            @alignOf(ChildEntry),
        ) orelse return false;
        const new_children: []ChildEntry = @as(
            [*]ChildEntry,
            @ptrCast(@alignCast(bytes.ptr)),
        )[0..new_cap];
        var j: usize = 0;
        while (j < dir.len) : (j += 1) new_children[j] = dir.children[j];
        dir.children = new_children;
        dir.capacity = new_cap;
    }
    const name_copy = dir.arena.dupe(child_name) orelse return false;
    dir.children[dir.len] = .{ .name = name_copy, .node = child };
    dir.len += 1;
    return true;
}

// -- tests -----------------------------------------------------------------
//
// Native-target unit tests. Run via
// `zig test src/contracts/wasi-shim/src/vfs/memfs.zig`.

const testing = std.testing;

test "write hello + world, read back helloworld" {
    var buf: [4096]u8 = undefined;
    var arena = MemfsArena.init(&buf);

    const dir = makeDir(&arena, "scratch").?;
    const file = makeFile(&arena, "f", null).?;
    try testing.expect(addChild(dir, "f", file));

    try testing.expectEqual(@as(usize, 5), try file.vtable.write(file, 0, "hello"));
    try testing.expectEqual(@as(usize, 5), try file.vtable.write(file, 5, "world"));

    var out: [16]u8 = undefined;
    const n = try file.vtable.read(file, 0, &out);
    try testing.expectEqual(@as(usize, 10), n);
    try testing.expectEqualStrings("helloworld", out[0..n]);
}

const Capture = struct {
    name: []const u8 = &.{},
    bytes: [16]u8 = undefined,
    len: usize = 0,
    fired: u32 = 0,
    name_buf: [32]u8 = undefined,

    fn cb(ctx: ?*anyopaque, name: []const u8, bytes: []const u8) void {
        const self: *Capture = @ptrCast(@alignCast(ctx.?));
        self.fired += 1;
        @memcpy(self.name_buf[0..name.len], name);
        self.name = self.name_buf[0..name.len];
        @memcpy(self.bytes[0..bytes.len], bytes);
        self.len = bytes.len;
    }
};

test "close fires on_close once with current bytes" {
    var buf: [4096]u8 = undefined;
    var arena = MemfsArena.init(&buf);

    var capture: Capture = .{};
    const file = makeFile(&arena, "out", .{ .fn_ = Capture.cb, .ctx = &capture }).?;
    _ = try file.vtable.write(file, 0, "hello");
    _ = try file.vtable.write(file, 5, "world");

    file.vtable.close(file);
    try testing.expectEqual(@as(u32, 1), capture.fired);
    try testing.expectEqualStrings("out", capture.name);
    try testing.expectEqualStrings("helloworld", capture.bytes[0..capture.len]);

    // Single-fire: subsequent close is a no-op.
    file.vtable.close(file);
    try testing.expectEqual(@as(u32, 1), capture.fired);
}

test "re-open same name produces a different file" {
    var buf: [4096]u8 = undefined;
    var arena = MemfsArena.init(&buf);

    const dir = makeDir(&arena, "/").?;
    const a = makeFile(&arena, "f", null).?;
    try testing.expect(addChild(dir, "f", a));

    // memfs has no name cache; the higher-level path layer is responsible
    // for "open existing" semantics. A second makeFile is just a new node.
    const b = makeFile(&arena, "f", null).?;
    try testing.expect(a != b);

    // addChild rejects the duplicate name -- prevents accidental shadowing.
    try testing.expect(!addChild(dir, "f", b));
}

test "read past EOF returns 0" {
    var buf: [1024]u8 = undefined;
    var arena = MemfsArena.init(&buf);

    const file = makeFile(&arena, "f", null).?;
    _ = try file.vtable.write(file, 0, "abc");

    var out: [4]u8 = undefined;
    try testing.expectEqual(@as(usize, 0), try file.vtable.read(file, 3, &out));
    try testing.expectEqual(@as(usize, 0), try file.vtable.read(file, 100, &out));
}

test "write at offset > len returns InvalidArgument" {
    var buf: [1024]u8 = undefined;
    var arena = MemfsArena.init(&buf);

    const file = makeFile(&arena, "f", null).?;
    _ = try file.vtable.write(file, 0, "abc");

    try testing.expectError(
        vfs.VfsError.InvalidArgument,
        file.vtable.write(file, 5, "x"),
    );
}

test "write inside existing range overwrites" {
    var buf: [1024]u8 = undefined;
    var arena = MemfsArena.init(&buf);

    const file = makeFile(&arena, "f", null).?;
    _ = try file.vtable.write(file, 0, "helloworld");
    _ = try file.vtable.write(file, 5, "WORLD");

    var out: [16]u8 = undefined;
    const n = try file.vtable.read(file, 0, &out);
    try testing.expectEqualStrings("helloWORLD", out[0..n]);
}

test "directory read/write returns IsADirectory" {
    var buf: [1024]u8 = undefined;
    var arena = MemfsArena.init(&buf);

    const dir = makeDir(&arena, "d").?;
    var out: [4]u8 = undefined;
    try testing.expectError(vfs.VfsError.IsADirectory, dir.vtable.read(dir, 0, &out));
    try testing.expectError(vfs.VfsError.IsADirectory, dir.vtable.write(dir, 0, "x"));
}

test "lookup finds added child, returns NotFound otherwise" {
    var buf: [1024]u8 = undefined;
    var arena = MemfsArena.init(&buf);

    const dir = makeDir(&arena, "d").?;
    const file = makeFile(&arena, "kid", null).?;
    try testing.expect(addChild(dir, "kid", file));

    const lookup = dir.vtable.lookup.?;
    try testing.expect((try lookup(dir, "kid")) == file);
    try testing.expectError(vfs.VfsError.NotFound, lookup(dir, "missing"));
}

test "readdir streams entries with cookie progression" {
    var buf: [4096]u8 = undefined;
    var arena = MemfsArena.init(&buf);

    const dir = makeDir(&arena, "d").?;
    var i: usize = 0;
    while (i < 3) : (i += 1) {
        var name_buf: [4]u8 = undefined;
        const name = std.fmt.bufPrint(&name_buf, "f{d}", .{i}) catch unreachable;
        const f = makeFile(&arena, name, null).?;
        try testing.expect(addChild(dir, name, f));
    }

    const readdir = dir.vtable.readdir.?;
    var entries: [2]vfs.DirEntry = undefined;
    try testing.expectEqual(@as(usize, 2), try readdir(dir, 0, &entries));
    try testing.expectEqualStrings("f0", entries[0].name);
    try testing.expectEqualStrings("f1", entries[1].name);

    try testing.expectEqual(@as(usize, 1), try readdir(dir, 2, &entries));
    try testing.expectEqualStrings("f2", entries[0].name);

    try testing.expectEqual(@as(usize, 0), try readdir(dir, 3, &entries));
}

test "addChild grows past initial capacity" {
    var buf: [16384]u8 = undefined;
    var arena = MemfsArena.init(&buf);

    const dir = makeDir(&arena, "d").?;
    var i: usize = 0;
    while (i < 50) : (i += 1) {
        var name_buf: [8]u8 = undefined;
        const name = std.fmt.bufPrint(&name_buf, "f{d}", .{i}) catch unreachable;
        const f = makeFile(&arena, name, null).?;
        try testing.expect(addChild(dir, name, f));
    }

    const lookup = dir.vtable.lookup.?;
    _ = try lookup(dir, "f49");
}

test "arena alloc returns null when exhausted" {
    var buf: [64]u8 = undefined;
    var arena = MemfsArena.init(&buf);
    try testing.expect(arena.alloc(32, 1) != null);
    try testing.expect(arena.alloc(1024, 1) == null);
}
