// Per-run mutable state for the WASI shim. Owned at module scope; reset by
// `init` at the top of every `run` invocation. All slices live in caller
// memory (typically the bump arena in `main.zig`) and must outlive the run.
//
// Reads happen through `current()`. There's a single instance — the shim
// runs one program at a time per `run` call, and re-entry isn't a thing in
// the deterministic execution model.

const std = @import("std");

const Sha256 = std.crypto.hash.sha2.Sha256;

pub const EnvEntry = struct { key: []const u8, val: []const u8 };

pub const State = struct {
    /// Block timestamp from `scaffold_env.timestamp()`, in milliseconds.
    timestamp_ms: u64,
    /// Hash of the running contract block.
    contract_hash: [32]u8,
    /// PRNG seed = SHA256(contract_hash || timestamp_ms_le_u64 || params).
    /// Computed in `init` from the args; never recomputed during a run.
    prng_seed: [32]u8,
    /// Counter shared by `random_get` + `/dev/random` + `/dev/urandom`.
    prng_counter: u64,
    /// Counter for `clock_time_get(MONOTONIC)` and the CPUTIME family.
    /// Starts at 0; advances by 1 per observation. Returned ns is the
    /// post-increment value (so the first call returns 1).
    monotonic_counter: u64,
    /// argv from `wasi_setup`. Each entry is bare arg bytes (no NUL).
    argv: []const []const u8,
    /// env from `wasi_setup`. Order preserved as listed.
    env: []const EnvEntry,
    /// Working directory from `wasi_setup`. Defaults to "/".
    cwd: []const u8,
    /// Preopen paths from `wasi_setup` (e.g. `/in`, `/out`, `/scratch`, `/dev`).
    preopens: []const []const u8,
    // FD table lands in Phase C.
};

pub const InitArgs = struct {
    timestamp_ms: u64,
    contract_hash: [32]u8,
    /// Bytes hashed into the PRNG seed alongside contract_hash + timestamp.
    /// Typically `scaffold_env.params()`.
    params: []const u8,
    argv: []const []const u8 = &.{},
    env: []const EnvEntry = &.{},
    cwd: []const u8 = "/",
    preopens: []const []const u8 = &.{ "/in", "/out", "/scratch", "/dev" },
};

/// Singleton storage. Lives in BSS — the shim has no allocator beyond the
/// bump arena, and the State struct itself owns no allocations (every slice
/// references caller memory).
var current_state: State = undefined;

/// Initialise the per-run state. Call once at the top of `run`. Slices in
/// `args` must have lifetime ≥ this run.
pub fn init(args: InitArgs) void {
    current_state = .{
        .timestamp_ms = args.timestamp_ms,
        .contract_hash = args.contract_hash,
        .prng_seed = computeSeed(args.contract_hash, args.timestamp_ms, args.params),
        .prng_counter = 0,
        .monotonic_counter = 0,
        .argv = args.argv,
        .env = args.env,
        .cwd = args.cwd,
        .preopens = args.preopens,
    };
}

/// Borrow the current state. Lifetime: until the next `init`.
pub fn current() *State {
    return &current_state;
}

fn computeSeed(contract_hash: [32]u8, timestamp_ms: u64, params: []const u8) [32]u8 {
    var ts_le: [8]u8 = undefined;
    std.mem.writeInt(u64, &ts_le, timestamp_ms, .little);

    var hasher = Sha256.init(.{});
    hasher.update(&contract_hash);
    hasher.update(&ts_le);
    hasher.update(params);
    var out: [32]u8 = undefined;
    hasher.final(&out);
    return out;
}

test "init computes deterministic seed" {
    const contract_hash = [_]u8{0x11} ** 32;
    const params = "hello world";

    init(.{
        .timestamp_ms = 1_700_000_000_000,
        .contract_hash = contract_hash,
        .params = params,
    });
    const seed_a = current().prng_seed;

    init(.{
        .timestamp_ms = 1_700_000_000_000,
        .contract_hash = contract_hash,
        .params = params,
    });
    const seed_b = current().prng_seed;

    try std.testing.expectEqualSlices(u8, &seed_a, &seed_b);

    init(.{
        .timestamp_ms = 1_700_000_000_001,
        .contract_hash = contract_hash,
        .params = params,
    });
    const seed_c = current().prng_seed;

    try std.testing.expect(!std.mem.eql(u8, &seed_a, &seed_c));
}

test "init resets counters" {
    init(.{
        .timestamp_ms = 42,
        .contract_hash = [_]u8{0} ** 32,
        .params = "",
    });
    current().prng_counter = 99;
    current().monotonic_counter = 77;

    init(.{
        .timestamp_ms = 42,
        .contract_hash = [_]u8{0} ** 32,
        .params = "",
    });
    try std.testing.expectEqual(@as(u64, 0), current().prng_counter);
    try std.testing.expectEqual(@as(u64, 0), current().monotonic_counter);
}
