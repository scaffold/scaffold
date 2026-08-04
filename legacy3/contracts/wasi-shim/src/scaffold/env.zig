// Zig-side wrapper around the `scaffold_env.*` externs declared in `main.zig`.
//
// All `i64` returns from `scaffold_env` follow the `packPtrLen` convention from
// `src/plugins/wasm/WasmWireCodec.ts`: high 32 bits are a pointer into the
// shim's own memory, low 32 bits are a length. The runtime stages bytes
// through the exported `alloc` bump allocator before returning, so the
// returned slice points into shim memory -- never into the program's memory.
//
// Slice lifetime: every returned slice is only valid until the next `alloc`
// call. Copy out anything you need to keep.
//
// The pointer-to-i32 conversions for outbound externs use `@bitCast` rather
// than `@intCast` so a shim arena that grows past 2 GiB doesn't trap on the
// cast itself; the wire bytes are identical for in-range pointers.

const std = @import("std");

const main = @import("../main.zig");

pub fn mode() u8 {
    return @intCast(main.mode());
}

pub fn timestamp() u64 {
    return @intCast(main.timestamp());
}

/// Slice valid until the next `alloc` call.
pub fn params() []const u8 {
    return unpack(main.params());
}

pub fn contractHash() [32]u8 {
    const slice = unpack(main.contract_hash());
    // Host contract: scaffold_env.contract_hash always returns 32 bytes.
    // Assert in safe builds; in ReleaseSmall the @memcpy below would trap on
    // a short slice anyway, but the assert documents the invariant.
    std.debug.assert(slice.len == 32);
    var out: [32]u8 = undefined;
    @memcpy(&out, slice[0..32]);
    return out;
}

/// Slice valid until the next `alloc` call. The host bridge converts a
/// missing record (typed env's `ContractRejection`) into an empty reply
/// rather than trapping; callers (notably `setup.read`) check for an
/// empty / unparseable reply and fall through to defaults. The returned
/// slice may therefore have `len == 0` even though the call did not
/// "fail" -- that's the missing-record signal.
pub fn contractMetadata(verifier: []const u8) []const u8 {
    return unpack(main.contract_metadata(
        ptrToI32(verifier.ptr),
        @intCast(verifier.len),
    ));
}

/// Slice valid until the next `alloc` call.
pub fn requestBody(verifier: []const u8) []const u8 {
    return unpack(main.request_body(
        ptrToI32(verifier.ptr),
        @intCast(verifier.len),
    ));
}

/// Slice valid until the next `alloc` call.
pub fn fetch(verifier: []const u8, key: []const u8) []const u8 {
    return unpack(main.fetch(
        ptrToI32(verifier.ptr),
        @intCast(verifier.len),
        ptrToI32(key.ptr),
        @intCast(key.len),
    ));
}

pub fn emitOutput(bytes: []const u8) void {
    main.emit_output(
        ptrToI32(bytes.ptr),
        @intCast(bytes.len),
    );
}

/// Diagnostic-only sink for `/out/debug` writes. The host forwards bytes
/// to `ctx.logger('contract').debug` (or silently drops if no logger is
/// wired). Never traps; safe to call on any code path.
pub fn debug(message: []const u8) void {
    main.debug(
        ptrToI32(message.ptr),
        @intCast(message.len),
    );
}

pub fn reject(reason: []const u8) noreturn {
    main.reject(
        ptrToI32(reason.ptr),
        @intCast(reason.len),
    );
    unreachable;
}

/// Convert a wasm32 pointer to the i32 the host extern signature wants.
/// Uses `@bitCast` so pointers above 2 GiB survive the cast (the host
/// reads the i32 sign-agnostically as the 32-bit address).
fn ptrToI32(p: anytype) i32 {
    const u: u32 = @intCast(@intFromPtr(p));
    return @bitCast(u);
}

fn unpack(packed_val: i64) []const u8 {
    const u: u64 = @bitCast(packed_val);
    const ptr: u32 = @intCast(u >> 32);
    const len: u32 = @intCast(u & 0xFFFF_FFFF);
    return @as([*]u8, @ptrFromInt(ptr))[0..len];
}
