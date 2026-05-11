// SHA3-256 wrapper. Scaffold's Hash.digest in src/util/Hash.ts uses SHA3-256
// (the Keccak-based FIPS 202 variant -- not Keccak-256 with the bare padding).
// std.crypto.hash.sha3.Sha3_256 is the exact match.

const std = @import("std");

pub const DIGEST_LEN = 32;

pub fn digest(data: []const u8) [DIGEST_LEN]u8 {
    var out: [DIGEST_LEN]u8 = undefined;
    std.crypto.hash.sha3.Sha3_256.hash(data, &out, .{});
    return out;
}
