// WASI random_get -- pulls deterministic bytes from the shared PRNG.

const abi = @import("types.zig");
const prng = @import("../prng.zig");
const state_mod = @import("../state.zig");
const prog_mem = @import("../scaffold/prog_mem.zig");

// Seed is fixed-zero pending a decision on which scaffold_env inputs feed it
// (see TODO.md). The PRNG stream is still deterministic per-run because
// `prng_counter` advances; what's missing is per-contract / per-block
// uniqueness, which the seed will provide once we settle on its inputs.
const ZERO_SEED: [32]u8 = [_]u8{0} ** 32;

pub fn random_get(buf: i32, buf_len: i32) i32 {
    if (buf_len < 0) return @intFromEnum(abi.Errno.INVAL);
    var staging: [4096]u8 = undefined;
    const st = state_mod.current();
    var dst: u32 = @intCast(buf);
    var remaining: u32 = @intCast(buf_len);
    while (remaining > 0) {
        const chunk = @min(remaining, staging.len);
        prng.fill(ZERO_SEED, &st.prng_counter, staging[0..chunk]);
        prog_mem.writeSlice(dst, staging[0..chunk]);
        dst += @intCast(chunk);
        remaining -= @intCast(chunk);
    }
    return @intFromEnum(abi.Errno.SUCCESS);
}
