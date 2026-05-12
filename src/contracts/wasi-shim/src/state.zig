// Shim-wide state set up at the start of each `run`. Everything here is
// process-global by design: a contract execution is one call, the state is
// initialised once, and the WASI handlers read it during dispatch.

const std = @import("std");

pub const Config = struct {
    /// Block timestamp in milliseconds (scaffold's native unit). Multiply by
    /// 1_000_000 when surfacing as WASI nanoseconds.
    timestamp_ms: u64,
    /// Packed (ptr, len) into shim memory for the 32-byte contract hash.
    /// We keep the raw packed value -- handlers that actually need the bytes
    /// re-derive the slice. Avoids an extra memcpy at init time.
    contract_hash_packed: i64,
};

pub var cfg: Config = .{
    .timestamp_ms = 0,
    .contract_hash_packed = 0,
};

/// Strictly-increasing call counter for `clock_time_get(MONOTONIC)`. Every
/// monotonic-clock observation advances by 1 ns so even busy-poll programs
/// make deterministic progress.
pub var monotonic_counter_ns: u64 = 0;

/// PRNG state for `random_get` and `/dev/random`. Counter-mode H(seed‖i).
/// Seed = H(contract_hash). v1: lazy init on first random use.
pub var prng_position: u64 = 0;
pub var prng_seed_initialised: bool = false;
pub var prng_seed: [32]u8 = .{0} ** 32;

pub fn init(c: Config) void {
    cfg = c;
    monotonic_counter_ns = 0;
    prng_position = 0;
    prng_seed_initialised = false;
}
