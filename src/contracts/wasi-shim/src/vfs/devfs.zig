// /dev mount: null, zero, random, urandom + the directory listing them.
// random and urandom are deliberately the same Node singleton — WASI makes
// no blocking distinction and the design says both consume the shared PRNG
// stream tracked on `state` (see docs/design/wasi-shim.md §"/dev/random and
// /dev/urandom"). Writes to all four are discarded; entropy mixing on the
// random sinks would break determinism.

const std = @import("std");

const vfs = @import("vfs.zig");
const prng = @import("../prng.zig");
const state = @import("../state.zig");

// -- /dev/null --------------------------------------------------------------

fn nullStat(_: *vfs.Node) vfs.VfsError!vfs.Stat {
    return .{ .filetype = .CHARACTER_DEVICE, .size = 0 };
}

fn nullRead(_: *vfs.Node, _: u64, _: []u8) vfs.VfsError!usize {
    return 0;
}

fn discardWrite(_: *vfs.Node, _: u64, src: []const u8) vfs.VfsError!usize {
    return src.len;
}

fn noopClose(_: *vfs.Node) void {}

const dev_null_vtable: vfs.NodeVTable = .{
    .stat = nullStat,
    .read = nullRead,
    .write = discardWrite,
    .close = noopClose,
    .readdir = null,
    .lookup = null,
};

var dev_null_node: vfs.Node = .{ .vtable = &dev_null_vtable };
pub const dev_null: *vfs.Node = &dev_null_node;

// -- /dev/zero --------------------------------------------------------------

fn zeroStat(_: *vfs.Node) vfs.VfsError!vfs.Stat {
    return .{ .filetype = .CHARACTER_DEVICE, .size = 0 };
}

fn zeroRead(_: *vfs.Node, _: u64, out: []u8) vfs.VfsError!usize {
    @memset(out, 0);
    return out.len;
}

const dev_zero_vtable: vfs.NodeVTable = .{
    .stat = zeroStat,
    .read = zeroRead,
    .write = discardWrite,
    .close = noopClose,
    .readdir = null,
    .lookup = null,
};

var dev_zero_node: vfs.Node = .{ .vtable = &dev_zero_vtable };
pub const dev_zero: *vfs.Node = &dev_zero_node;

// -- /dev/random and /dev/urandom (same singleton) --------------------------

fn randomStat(_: *vfs.Node) vfs.VfsError!vfs.Stat {
    return .{ .filetype = .CHARACTER_DEVICE, .size = 0 };
}

fn randomRead(_: *vfs.Node, _: u64, out: []u8) vfs.VfsError!usize {
    const s = state.current();
    prng.fill(s.prng_seed, &s.prng_counter, out);
    return out.len;
}

const dev_random_vtable: vfs.NodeVTable = .{
    .stat = randomStat,
    .read = randomRead,
    .write = discardWrite,
    .close = noopClose,
    .readdir = null,
    .lookup = null,
};

var dev_random_node: vfs.Node = .{ .vtable = &dev_random_vtable };
pub const dev_random: *vfs.Node = &dev_random_node;
pub const dev_urandom: *vfs.Node = &dev_random_node;

// -- /dev (directory) -------------------------------------------------------

const DirChild = struct { name: []const u8, node: *vfs.Node };

const dev_children = [_]DirChild{
    .{ .name = "null", .node = dev_null },
    .{ .name = "zero", .node = dev_zero },
    .{ .name = "random", .node = dev_random },
    .{ .name = "urandom", .node = dev_urandom },
};

fn dirStat(_: *vfs.Node) vfs.VfsError!vfs.Stat {
    return .{ .filetype = .DIRECTORY, .size = 0 };
}

fn dirRead(_: *vfs.Node, _: u64, _: []u8) vfs.VfsError!usize {
    return vfs.VfsError.IsADirectory;
}

fn dirWrite(_: *vfs.Node, _: u64, _: []const u8) vfs.VfsError!usize {
    return vfs.VfsError.IsADirectory;
}

fn dirLookup(_: *vfs.Node, name: []const u8) vfs.VfsError!*vfs.Node {
    for (dev_children) |child| {
        if (std.mem.eql(u8, child.name, name)) return child.node;
    }
    return vfs.VfsError.NotFound;
}

fn dirReaddir(_: *vfs.Node, cookie: u64, out: []vfs.DirEntry) vfs.VfsError!usize {
    if (cookie >= dev_children.len) return 0;
    const start: usize = @intCast(cookie);
    const remaining = dev_children.len - start;
    const n = @min(remaining, out.len);
    var i: usize = 0;
    while (i < n) : (i += 1) {
        out[i] = .{ .name = dev_children[start + i].name, .filetype = .CHARACTER_DEVICE };
    }
    return n;
}

const dev_dir_vtable: vfs.NodeVTable = .{
    .stat = dirStat,
    .read = dirRead,
    .write = dirWrite,
    .close = noopClose,
    .readdir = dirReaddir,
    .lookup = dirLookup,
};

var dev_dir_node: vfs.Node = .{ .vtable = &dev_dir_vtable };
pub const dev_dir: *vfs.Node = &dev_dir_node;

// -- tests ------------------------------------------------------------------
//
// `zig test src/contracts/wasi-shim/src/vfs/devfs.zig` runs these natively.
// Tests that touch random/urandom seed `state` first so the PRNG has
// well-defined inputs.

const testing = std.testing;

fn initTestState() void {
    state.init(.{
        .timestamp_ms = 1_700_000_000_000,
        .contract_hash = [_]u8{0x42} ** 32,
        .params = "devfs-test",
    });
}

test "/dev/null read returns 0, write returns src.len" {
    var buf: [16]u8 = undefined;
    try testing.expectEqual(@as(usize, 0), try dev_null.vtable.read(dev_null, 0, &buf));

    const payload = "anything you like";
    try testing.expectEqual(payload.len, try dev_null.vtable.write(dev_null, 0, payload));

    const stat = try dev_null.vtable.stat(dev_null);
    try testing.expectEqual(vfs.Filetype.CHARACTER_DEVICE, stat.filetype);
    try testing.expectEqual(@as(u64, 0), stat.size);
}

test "/dev/zero read fills with 0x00" {
    var buf: [16]u8 = undefined;
    @memset(&buf, 0xFF); // poison so we know read actually wrote
    try testing.expectEqual(buf.len, try dev_zero.vtable.read(dev_zero, 0, &buf));
    for (buf) |b| try testing.expectEqual(@as(u8, 0), b);

    const payload = "discard me";
    try testing.expectEqual(payload.len, try dev_zero.vtable.write(dev_zero, 0, payload));
}

test "/dev/random and /dev/urandom share the prng counter" {
    initTestState();
    try testing.expectEqual(@as(u64, 0), state.current().prng_counter);

    var first: [16]u8 = undefined;
    _ = try dev_random.vtable.read(dev_random, 0, &first);
    // 16 bytes < one 32-byte block → counter advances by 1.
    try testing.expectEqual(@as(u64, 1), state.current().prng_counter);

    var second: [16]u8 = undefined;
    _ = try dev_urandom.vtable.read(dev_urandom, 0, &second);
    try testing.expectEqual(@as(u64, 2), state.current().prng_counter);

    // Different counter values → different bytes (the whole point of sharing).
    try testing.expect(!std.mem.eql(u8, &first, &second));

    // urandom is the same singleton, not a copy.
    try testing.expect(dev_random == dev_urandom);
}

test "/dev/random write is discarded (no entropy mixing)" {
    initTestState();
    const counter_before = state.current().prng_counter;
    const seed_before = state.current().prng_seed;

    const payload = "would-be entropy";
    try testing.expectEqual(payload.len, try dev_random.vtable.write(dev_random, 0, payload));

    try testing.expectEqual(counter_before, state.current().prng_counter);
    try testing.expectEqualSlices(u8, &seed_before, &state.current().prng_seed);
}

test "/dev/random stat reports CHARACTER_DEVICE size 0" {
    const stat = try dev_random.vtable.stat(dev_random);
    try testing.expectEqual(vfs.Filetype.CHARACTER_DEVICE, stat.filetype);
    try testing.expectEqual(@as(u64, 0), stat.size);
}

test "/dev lookup resolves all four names" {
    try testing.expect((try dev_dir.vtable.lookup.?(dev_dir, "null")) == dev_null);
    try testing.expect((try dev_dir.vtable.lookup.?(dev_dir, "zero")) == dev_zero);
    try testing.expect((try dev_dir.vtable.lookup.?(dev_dir, "random")) == dev_random);
    try testing.expect((try dev_dir.vtable.lookup.?(dev_dir, "urandom")) == dev_urandom);
}

test "/dev lookup returns NotFound for unknown names" {
    try testing.expectError(vfs.VfsError.NotFound, dev_dir.vtable.lookup.?(dev_dir, "missing"));
    try testing.expectError(vfs.VfsError.NotFound, dev_dir.vtable.lookup.?(dev_dir, ""));
}

test "/dev readdir returns four entries in declaration order: null, zero, random, urandom" {
    var buf: [4]vfs.DirEntry = undefined;
    const n = try dev_dir.vtable.readdir.?(dev_dir, 0, &buf);
    try testing.expectEqual(@as(usize, 4), n);
    try testing.expectEqualStrings("null", buf[0].name);
    try testing.expectEqualStrings("zero", buf[1].name);
    try testing.expectEqualStrings("random", buf[2].name);
    try testing.expectEqualStrings("urandom", buf[3].name);
    for (buf) |entry| try testing.expectEqual(vfs.Filetype.CHARACTER_DEVICE, entry.filetype);
}

test "/dev readdir honours cookie and short buffers" {
    var buf: [2]vfs.DirEntry = undefined;
    try testing.expectEqual(@as(usize, 2), try dev_dir.vtable.readdir.?(dev_dir, 0, &buf));
    try testing.expectEqualStrings("null", buf[0].name);
    try testing.expectEqualStrings("zero", buf[1].name);

    try testing.expectEqual(@as(usize, 2), try dev_dir.vtable.readdir.?(dev_dir, 2, &buf));
    try testing.expectEqualStrings("random", buf[0].name);
    try testing.expectEqualStrings("urandom", buf[1].name);

    // Cookie at/past end → 0 entries (EOF).
    try testing.expectEqual(@as(usize, 0), try dev_dir.vtable.readdir.?(dev_dir, 4, &buf));
    try testing.expectEqual(@as(usize, 0), try dev_dir.vtable.readdir.?(dev_dir, 99, &buf));
}

test "/dev directory rejects read and write" {
    var buf: [4]u8 = undefined;
    try testing.expectError(vfs.VfsError.IsADirectory, dev_dir.vtable.read(dev_dir, 0, &buf));
    try testing.expectError(vfs.VfsError.IsADirectory, dev_dir.vtable.write(dev_dir, 0, "x"));
}

test "vfs.resolve walks /dev/zero from the dev directory" {
    const r = try vfs.resolve(dev_dir, "/zero");
    try testing.expect(r.node == dev_zero);
}
