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
    var out: [32]u8 = undefined;
    @memcpy(&out, slice[0..32]);
    return out;
}

/// Slice valid until the next `alloc` call.
pub fn contractMetadata(verifier: []const u8) []const u8 {
    return unpack(main.contract_metadata(
        @intCast(@intFromPtr(verifier.ptr)),
        @intCast(verifier.len),
    ));
}

/// Slice valid until the next `alloc` call.
pub fn requestBody(verifier: []const u8) []const u8 {
    return unpack(main.request_body(
        @intCast(@intFromPtr(verifier.ptr)),
        @intCast(verifier.len),
    ));
}

/// Slice valid until the next `alloc` call.
pub fn fetch(verifier: []const u8, key: []const u8) []const u8 {
    return unpack(main.fetch(
        @intCast(@intFromPtr(verifier.ptr)),
        @intCast(verifier.len),
        @intCast(@intFromPtr(key.ptr)),
        @intCast(key.len),
    ));
}

pub fn emitOutput(bytes: []const u8) void {
    main.emit_output(
        @intCast(@intFromPtr(bytes.ptr)),
        @intCast(bytes.len),
    );
}

pub fn reject(reason: []const u8) noreturn {
    main.reject(
        @intCast(@intFromPtr(reason.ptr)),
        @intCast(reason.len),
    );
    unreachable;
}

fn unpack(packed_val: i64) []const u8 {
    const u: u64 = @bitCast(packed_val);
    const ptr: u32 = @intCast(u >> 32);
    const len: u32 = @intCast(u & 0xFFFF_FFFF);
    return @as([*]u8, @ptrFromInt(ptr))[0..len];
}
