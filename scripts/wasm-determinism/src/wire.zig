// Scaffold wire-format encoders. Matches src/plugins/wasm/WasmWireCodec.ts.
// All multi-byte ints are little-endian.

const std = @import("std");

pub const HASH_LEN = 32;
pub const I128_LEN = 16;

/// Encode a Verifier. Returns the number of bytes written.
/// Layout: contract(32B) || params_len(u32 LE) || params(bytes)
pub fn encodeVerifier(contract: [HASH_LEN]u8, params: []const u8, out: []u8) usize {
    @memcpy(out[0..HASH_LEN], &contract);
    std.mem.writeInt(u32, out[HASH_LEN..][0..4], @intCast(params.len), .little);
    @memcpy(out[HASH_LEN + 4 .. HASH_LEN + 4 + params.len], params);
    return HASH_LEN + 4 + params.len;
}

pub fn verifierSize(params_len: usize) usize {
    return HASH_LEN + 4 + params_len;
}

/// Encode an Output. Returns the number of bytes written.
/// Layout: Verifier || value(i128 LE) || data_len(u32 LE) || data(bytes)
pub fn encodeOutput(
    contract: [HASH_LEN]u8,
    params: []const u8,
    value: i128,
    data: []const u8,
    out: []u8,
) usize {
    var pos: usize = encodeVerifier(contract, params, out);
    std.mem.writeInt(i128, out[pos..][0..I128_LEN], value, .little);
    pos += I128_LEN;
    std.mem.writeInt(u32, out[pos..][0..4], @intCast(data.len), .little);
    pos += 4;
    @memcpy(out[pos..][0..data.len], data);
    pos += data.len;
    return pos;
}

pub fn outputSize(params_len: usize, data_len: usize) usize {
    return verifierSize(params_len) + I128_LEN + 4 + data_len;
}

/// Decode a `value + bytes body` reply (the wire format for `contract_metadata`
/// and `request_body` returns). The buffer is exactly `I128_LEN + 4 + body_len`.
pub fn decodeValueAndBody(bytes: []const u8) struct { value: i128, body: []const u8 } {
    const value = std.mem.readInt(i128, bytes[0..I128_LEN], .little);
    const body_len = std.mem.readInt(u32, bytes[I128_LEN..][0..4], .little);
    const body = bytes[I128_LEN + 4 .. I128_LEN + 4 + @as(usize, body_len)];
    return .{ .value = value, .body = body };
}
