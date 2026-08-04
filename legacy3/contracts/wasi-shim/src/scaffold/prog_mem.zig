// Typed wrappers over the `program_mem.*` imports declared in `main.zig`.
// The shim never touches the program's memory directly; every cross-memory
// read/write goes through this module.

const std = @import("std");

const main = @import("../main.zig");
const abi = @import("../abi/types.zig");

pub fn readSlice(src: u32, dst: []u8) void {
    main.read_bytes(
        @bitCast(src),
        ptrToI32(dst.ptr),
        @intCast(dst.len),
    );
}

pub fn writeSlice(dst: u32, src: []const u8) void {
    main.write_bytes(
        @bitCast(dst),
        ptrToI32(src.ptr),
        @intCast(src.len),
    );
}

/// Convert a wasm32 pointer to the i32 the host extern wants. `@bitCast`
/// keeps pointers above 2 GiB intact instead of trapping at the cast.
fn ptrToI32(p: anytype) i32 {
    const u: u32 = @intCast(@intFromPtr(p));
    return @bitCast(u);
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

/// Largest iovec table we'll bulk-read in one cross-memory hop. WASI
/// `iovs_len` is u32 in principle, but wasi-libc fans out to 1024 iovs at
/// the high end and most calls use 1-8. 1024 iovs × 8 bytes/iov = 8 KiB
/// of stack staging, comfortable for any reasonable call stack.
const IOVEC_BULK_BUFFER_BYTES: usize = 8192;

/// Bulk-decode an iovec table from program memory. One `read_bytes` hop
/// stages the whole table into a stack buffer; iovs are then unpacked
/// in-shim. For tables larger than the staging buffer we fall through to
/// chunked hops (still O(N/STAGE) hops, not O(N)).
pub fn readIovecs(src: u32, out: []abi.Iovec) void {
    var staging: [IOVEC_BULK_BUFFER_BYTES]u8 = undefined;
    const max_iovs_per_hop = staging.len / 8;
    var done: usize = 0;
    while (done < out.len) {
        const remaining = out.len - done;
        const this_batch = @min(remaining, max_iovs_per_hop);
        const bytes_this_hop = this_batch * 8;
        readSlice(src + @as(u32, @intCast(done * 8)), staging[0..bytes_this_hop]);
        var i: usize = 0;
        while (i < this_batch) : (i += 1) {
            const off = i * 8;
            out[done + i] = .{
                .buf = std.mem.readInt(u32, staging[off..][0..4], .little),
                .buf_len = std.mem.readInt(u32, staging[off + 4 ..][0..4], .little),
            };
        }
        done += this_batch;
    }
}
