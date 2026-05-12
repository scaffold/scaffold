// random_get -- deterministic PRNG.
//
// The PRNG is counter-mode H(seed || counter), where:
//   seed    = contract_hash (32 bytes)
//   counter = u64, advances once per 32-byte output block
//
// `random_get` and reads from `/dev/random` (in the future) share the same
// stream by sharing `state.prng_position`. SHA-256 is overkill for a PRNG
// but Zig's std lib has it and we already depend on hash determinism
// everywhere in scaffold.
//
// Why deterministic: a contract is executed by many peers and must produce
// the same outputs. Real entropy would make outputs diverge.

const std = @import("std");
const abi = @import("types.zig");
const state = @import("../state.zig");
const prog_mem = @import("../scaffold/prog_mem.zig");

const Sha256 = std.crypto.hash.sha2.Sha256;
const BLOCK = 32;

/// Seed the PRNG lazily from `contract_hash`. The contract hash is packed
/// (ptr, len) so we read 32 bytes from the shim's own memory.
fn ensure_seed() void {
    if (state.prng_seed_initialised) return;
    const packed_val: u64 = @bitCast(state.cfg.contract_hash_packed);
    const ptr: u32 = @intCast(packed_val >> 32);
    const len: u32 = @intCast(packed_val & 0xFFFFFFFF);
    // Defensive: scaffold's contract_hash always returns a 32-byte slice.
    if (len != 32) {
        // Shouldn't happen; if it does, leave seed zero (still deterministic).
        state.prng_seed_initialised = true;
        return;
    }
    const src: [*]const u8 = @ptrFromInt(ptr);
    @memcpy(&state.prng_seed, src[0..32]);
    state.prng_seed_initialised = true;
}

pub fn random_get(buf: i32, buf_len: i32) i32 {
    ensure_seed();
    var remaining: usize = @intCast(buf_len);
    var prog_off: u32 = @intCast(buf);
    var block: [BLOCK]u8 = undefined;
    while (remaining > 0) {
        var counter_le: [8]u8 = undefined;
        std.mem.writeInt(u64, &counter_le, state.prng_position, .little);
        var h = Sha256.init(.{});
        h.update(&state.prng_seed);
        h.update(&counter_le);
        h.final(&block);
        state.prng_position += 1;
        const take = @min(remaining, BLOCK);
        prog_mem.store_bytes(prog_off, block[0..take]);
        prog_off += @intCast(take);
        remaining -= take;
    }
    return abi.ok();
}
