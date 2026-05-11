// Scaffold contract ABI host imports.
// Spec: docs/protocol/wasm-abi.md#host-import-surface

const std = @import("std");
const wire = @import("wire.zig");

// All host imports use the packed (ptr, len) i64 convention:
//   packed = (u64(ptr) << 32) | u64(len)

extern "scaffold_env" fn params() i64;
extern "scaffold_env" fn contract_metadata(verifier_ptr: u32, verifier_len: u32) i64;
extern "scaffold_env" fn fetch(verifier_ptr: u32, verifier_len: u32, key_ptr: u32, key_len: u32) i64;
extern "scaffold_env" fn emit_output(out_ptr: u32, out_len: u32) void;
extern "scaffold_env" fn reject(reason_ptr: u32, reason_len: u32) noreturn;

fn unpack(packed_v: i64) struct { ptr: u32, len: u32 } {
    const u: u64 = @bitCast(packed_v);
    return .{
        .ptr = @intCast(u >> 32),
        .len = @intCast(u & 0xffff_ffff),
    };
}

fn sliceFrom(packed_v: i64) []u8 {
    const p = unpack(packed_v);
    if (p.len == 0) return &.{};
    const base: [*]u8 = @ptrFromInt(@as(usize, p.ptr));
    return base[0..p.len];
}

pub fn getParams() []const u8 {
    return sliceFrom(params());
}

pub fn doReject(reason: []const u8) noreturn {
    reject(@intCast(@intFromPtr(reason.ptr)), @intCast(reason.len));
}

pub fn doFetch(verifier_bytes: []const u8, key: []const u8) []const u8 {
    const packed_v = fetch(
        @intCast(@intFromPtr(verifier_bytes.ptr)),
        @intCast(verifier_bytes.len),
        @intCast(@intFromPtr(key.ptr)),
        @intCast(key.len),
    );
    return sliceFrom(packed_v);
}

pub fn doEmitOutput(output_bytes: []const u8) void {
    emit_output(
        @intCast(@intFromPtr(output_bytes.ptr)),
        @intCast(output_bytes.len),
    );
}

pub const MetadataReply = struct {
    value: i128,
    body: []const u8,
};

pub fn doContractMetadata(verifier_bytes: []const u8) MetadataReply {
    const packed_v = contract_metadata(
        @intCast(@intFromPtr(verifier_bytes.ptr)),
        @intCast(verifier_bytes.len),
    );
    const bytes = sliceFrom(packed_v);
    const parsed = wire.decodeValueAndBody(bytes);
    return .{ .value = parsed.value, .body = parsed.body };
}
