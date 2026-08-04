// Deterministic counter-mode PRNG: H(seed || counter_le8) per 32-byte block.
// Seed is opaque here -- callers pass it in. Today the wasi-shim wires a
// fixed-zero seed (see abi/random.zig and vfs/devfs.zig) while we decide
// which scaffold_env inputs should feed it; the counter is shared across all
// consumers (random_get, /dev/random, /dev/urandom) so the stream stays
// single-source and deterministic.

const std = @import("std");

const Sha256 = std.crypto.hash.sha2.Sha256;
const block_len = Sha256.digest_length;

/// Fill `out` with deterministic bytes. Advances `counter` by
/// `ceil(out.len / 32)`. Same `(seed, counter)` always produces same bytes.
pub fn fill(seed: [32]u8, counter: *u64, out: []u8) void {
    var written: usize = 0;
    while (written < out.len) {
        const block = hashBlock(seed, counter.*);
        const remaining = out.len - written;
        const n = @min(block_len, remaining);
        @memcpy(out[written..][0..n], block[0..n]);
        written += n;
        counter.* += 1;
    }
}

fn hashBlock(seed: [32]u8, counter: u64) [block_len]u8 {
    var counter_le: [8]u8 = undefined;
    // Pin endianness explicitly so the stream is portable across builds.
    std.mem.writeInt(u64, &counter_le, counter, .little);

    var hasher = Sha256.init(.{});
    hasher.update(&seed);
    hasher.update(&counter_le);
    var out: [block_len]u8 = undefined;
    hasher.final(&out);
    return out;
}

test "prng determinism" {
    const seed = [_]u8{0xAB} ** 32;

    var counter_a: u64 = 0;
    var buf_a: [100]u8 = undefined;
    fill(seed, &counter_a, &buf_a);

    var counter_b: u64 = 0;
    var buf_b: [100]u8 = undefined;
    fill(seed, &counter_b, &buf_b);

    try std.testing.expectEqualSlices(u8, &buf_a, &buf_b);

    var counter_c: u64 = 10;
    var buf_c: [100]u8 = undefined;
    fill(seed, &counter_c, &buf_c);

    try std.testing.expect(!std.mem.eql(u8, &buf_a, &buf_c));

    var counter_d: u64 = 0;
    var buf_d: [64]u8 = undefined;
    fill(seed, &counter_d, &buf_d);
    try std.testing.expectEqual(@as(u64, 2), counter_d);
}
