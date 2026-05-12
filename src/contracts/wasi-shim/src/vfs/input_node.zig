// Read-only callback-backed node. Used for /in/* paths whose bytes come from scaffold_env.

const std = @import("std");
const vfs = @import("vfs.zig");

pub const Producer = *const fn (ctx: ?*anyopaque) ?[]const u8;

pub const InputNode = struct {
    node: vfs.Node,
    producer: Producer,
    ctx: ?*anyopaque,
    cached: ?[]const u8,
};

const vtable: vfs.NodeVTable = .{
    .stat = statImpl,
    .read = readImpl,
    .write = writeImpl,
    .close = closeImpl,
    .readdir = null,
    .lookup = null,
};

pub fn init(self: *InputNode, producer: Producer, ctx: ?*anyopaque) void {
    self.* = .{
        .node = .{ .vtable = &vtable },
        .producer = producer,
        .ctx = ctx,
        .cached = null,
    };
}

pub fn initFixed(self: *InputNode, bytes: []const u8) void {
    self.* = .{
        .node = .{ .vtable = &vtable },
        .producer = fixedProducer,
        .ctx = null,
        .cached = bytes,
    };
}

fn fixedProducer(_: ?*anyopaque) ?[]const u8 {
    return null;
}

fn statImpl(node: *vfs.Node) vfs.VfsError!vfs.Stat {
    const self: *InputNode = @fieldParentPtr("node", node);
    const size: u64 = if (self.cached) |bytes| bytes.len else 0;
    return .{ .filetype = vfs.Filetype.REGULAR_FILE, .size = size };
}

// Producer is not called until the first read, so opening a fetch path
// does not cost a scaffold call.
fn readImpl(node: *vfs.Node, offset: u64, out: []u8) vfs.VfsError!usize {
    const self: *InputNode = @fieldParentPtr("node", node);
    if (self.cached == null) {
        self.cached = self.producer(self.ctx) orelse return vfs.VfsError.NotSupported;
    }
    const bytes = self.cached.?;
    if (offset >= bytes.len) return 0;
    const start: usize = @intCast(offset);
    const remaining = bytes.len - start;
    const n = @min(remaining, out.len);
    @memcpy(out[0..n], bytes[start..][0..n]);
    return n;
}

fn writeImpl(_: *vfs.Node, _: u64, _: []const u8) vfs.VfsError!usize {
    return vfs.VfsError.ReadOnly;
}

fn closeImpl(_: *vfs.Node) void {}

// -- tests -----------------------------------------------------------------

const testing = std.testing;

const CountingCtx = struct {
    calls: u32 = 0,
    bytes: []const u8,
};

fn countingProducer(ctx: ?*anyopaque) ?[]const u8 {
    const c: *CountingCtx = @ptrCast(@alignCast(ctx.?));
    c.calls += 1;
    return c.bytes;
}

fn nullProducer(_: ?*anyopaque) ?[]const u8 {
    return null;
}

test "read returns producer bytes and caches them" {
    var ctx = CountingCtx{ .bytes = "hello" };
    var n: InputNode = undefined;
    init(&n, countingProducer, &ctx);

    var buf: [5]u8 = undefined;
    const got = try n.node.vtable.read(&n.node, 0, &buf);
    try testing.expectEqual(@as(usize, 5), got);
    try testing.expectEqualSlices(u8, "hello", buf[0..]);
    try testing.expectEqual(@as(u32, 1), ctx.calls);

    var buf2: [5]u8 = undefined;
    const got2 = try n.node.vtable.read(&n.node, 0, &buf2);
    try testing.expectEqual(@as(usize, 5), got2);
    try testing.expectEqualSlices(u8, "hello", buf2[0..]);
    try testing.expectEqual(@as(u32, 1), ctx.calls);
}

test "read past EOF returns 0" {
    var ctx = CountingCtx{ .bytes = "hi" };
    var n: InputNode = undefined;
    init(&n, countingProducer, &ctx);

    var buf: [4]u8 = undefined;
    const first = try n.node.vtable.read(&n.node, 0, &buf);
    try testing.expectEqual(@as(usize, 2), first);

    const past = try n.node.vtable.read(&n.node, 2, &buf);
    try testing.expectEqual(@as(usize, 0), past);

    const way_past = try n.node.vtable.read(&n.node, 100, &buf);
    try testing.expectEqual(@as(usize, 0), way_past);
}

test "initFixed serves the supplied bytes" {
    var n: InputNode = undefined;
    initFixed(&n, "world");

    var buf: [5]u8 = undefined;
    const got = try n.node.vtable.read(&n.node, 0, &buf);
    try testing.expectEqual(@as(usize, 5), got);
    try testing.expectEqualSlices(u8, "world", buf[0..]);
}

test "write returns ReadOnly" {
    var n: InputNode = undefined;
    initFixed(&n, "x");
    try testing.expectError(
        vfs.VfsError.ReadOnly,
        n.node.vtable.write(&n.node, 0, "y"),
    );
}

test "producer returning null surfaces NotSupported" {
    var n: InputNode = undefined;
    init(&n, nullProducer, null);
    var buf: [4]u8 = undefined;
    try testing.expectError(
        vfs.VfsError.NotSupported,
        n.node.vtable.read(&n.node, 0, &buf),
    );
}

test "stat reports size 0 before read, real size after" {
    var ctx = CountingCtx{ .bytes = "hello" };
    var n: InputNode = undefined;
    init(&n, countingProducer, &ctx);

    const before = try n.node.vtable.stat(&n.node);
    try testing.expectEqual(vfs.Filetype.REGULAR_FILE, before.filetype);
    try testing.expectEqual(@as(u64, 0), before.size);

    var buf: [5]u8 = undefined;
    _ = try n.node.vtable.read(&n.node, 0, &buf);

    const after = try n.node.vtable.stat(&n.node);
    try testing.expectEqual(@as(u64, 5), after.size);
}
