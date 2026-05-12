// Typed wrappers over the `program_mem.*` imports declared in `main.zig`.
// The shim never touches the program's memory directly; every cross-memory
// read/write goes through this module.

const std = @import("std");

const main = @import("../main.zig");
const abi = @import("../abi/types.zig");

pub fn readSlice(src: u32, dst: []u8) void {
    main.read_bytes(
        @intCast(src),
        @intCast(@intFromPtr(dst.ptr)),
        @intCast(dst.len),
    );
}

pub fn writeSlice(dst: u32, src: []const u8) void {
    main.write_bytes(
        @intCast(dst),
        @intCast(@intFromPtr(src.ptr)),
        @intCast(src.len),
    );
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

pub fn readU64(src: u32) u64 {
    var buf: [8]u8 = undefined;
    readSlice(src, &buf);
    return std.mem.readInt(u64, &buf, .little);
}

pub fn writeU64(dst: u32, value: u64) void {
    var buf: [8]u8 = undefined;
    std.mem.writeInt(u64, &buf, value, .little);
    writeSlice(dst, &buf);
}

pub fn readIovecs(src: u32, out: []abi.Iovec) void {
    for (out, 0..) |*iov, i| {
        const base = src + @as(u32, @intCast(i * 8));
        iov.* = .{
            .buf = readU32(base),
            .buf_len = readU32(base + 4),
        };
    }
}
