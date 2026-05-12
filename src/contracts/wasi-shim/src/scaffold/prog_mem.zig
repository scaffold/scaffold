// Typed helpers over the `program_mem.*` accessor functions.
//
// All WASI output pointers (the `out_*` parameters to clock_time_get, the
// argv/argv_buf pointers in args_get, the iovec buffer in fd_read) are
// offsets into the PROGRAM'S memory, NOT the shim's. We stage values in a
// shim-local buffer and push them across via `program_mem.write_bytes`.
//
// Reads use the symmetric `program_mem.read_bytes` -- they pull program
// bytes into a shim-local buffer where we can read them with normal Zig.

const std = @import("std");
const main = @import("../main.zig");

pub fn store_u32_le(prog_off: u32, value: u32) void {
    var buf: [4]u8 = undefined;
    std.mem.writeInt(u32, &buf, value, .little);
    main.write_bytes(@intCast(prog_off), @intCast(@intFromPtr(&buf)), 4);
}

pub fn store_u64_le(prog_off: u32, value: u64) void {
    var buf: [8]u8 = undefined;
    std.mem.writeInt(u64, &buf, value, .little);
    main.write_bytes(@intCast(prog_off), @intCast(@intFromPtr(&buf)), 8);
}

pub fn store_bytes(prog_off: u32, src: []const u8) void {
    if (src.len == 0) return;
    main.write_bytes(@intCast(prog_off), @intCast(@intFromPtr(src.ptr)), @intCast(src.len));
}

pub fn load_u32_le(prog_off: u32) u32 {
    var buf: [4]u8 = undefined;
    main.read_bytes(@intCast(prog_off), @intCast(@intFromPtr(&buf)), 4);
    return std.mem.readInt(u32, &buf, .little);
}

pub fn load_bytes(prog_off: u32, dst: []u8) void {
    if (dst.len == 0) return;
    main.read_bytes(@intCast(prog_off), @intCast(@intFromPtr(dst.ptr)), @intCast(dst.len));
}
