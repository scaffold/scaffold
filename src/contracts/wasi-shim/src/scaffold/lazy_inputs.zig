// Lazy, cached accessors for the three `scaffold_env` scalars that aren't
// needed at shim startup: `contract_hash`, `params`, `timestamp`.
//
// Each scalar is fetched on its first call to the accessor here and cached
// for the rest of the run. The caches are zeroed by `reset()` at the top of
// `main.run` -- the shim handles one program per `run` invocation, so a
// fresh run always re-fetches.
//
// Why these are split out from `state.zig`: the lazy fetch calls back into
// `scaffold/env.zig`, which depends on `main.zig`'s `scaffold_env.*`
// externs. Putting the caches on `state` would mean `state.zig` imports
// `env.zig` imports `main.zig` imports `state.zig` -- a cycle the Zig
// build can resolve at the file level but that obscures the layering. The
// caches are functionally per-run, like `paths.zig`'s root-node singleton,
// so they live alongside that.
//
// Slice lifetime for `paramsBytes()`: the bytes come from the shim's bump
// arena (via `env.params()`), which only grows within a run. The cached
// slice therefore stays valid until the next `reset()`.

const env = @import("env.zig");

// One "fetched?" flag per scalar plus addressable storage. Splitting the
// flag out (vs an `?T`) lets `contractHashSlice()` return a stable
// `[]const u8` pointing into the storage -- callers that hold a slice
// across multiple reads (e.g. the `/in/contract_hash` input node) don't
// need their own BSS copy.

var timestamp_ms_fetched: bool = false;
var timestamp_ms_storage: u64 = 0;

var contract_hash_fetched: bool = false;
var contract_hash_storage: [32]u8 = undefined;

var params_fetched: bool = false;
var params_storage: []const u8 = &[_]u8{};

/// Drop all cached values. Call at the top of each `run` so the next program
/// invocation re-fetches against the new block's state.
pub fn reset() void {
    timestamp_ms_fetched = false;
    contract_hash_fetched = false;
    params_fetched = false;
    // No need to zero the storage; the `*_fetched` flags gate every read.
}

/// Block timestamp in milliseconds. First call traps to `scaffold_env.timestamp`.
pub fn timestampMs() u64 {
    if (!timestamp_ms_fetched) {
        timestamp_ms_storage = env.timestamp();
        timestamp_ms_fetched = true;
    }
    return timestamp_ms_storage;
}

/// Hash of the running contract block. First call traps to
/// `scaffold_env.contract_hash` (which returns 32 bytes per host contract).
pub fn contractHash() [32]u8 {
    fetchContractHash();
    return contract_hash_storage;
}

/// Slice view of the cached contract hash. Lifetime is tied to the cache
/// storage, so the slice stays valid until the next `reset()`. Use this
/// for callers (e.g. `/in/contract_hash`'s input node) that store a slice
/// and read it later; the value-returning `contractHash()` is for one-shot
/// uses.
pub fn contractHashSlice() []const u8 {
    fetchContractHash();
    return contract_hash_storage[0..];
}

fn fetchContractHash() void {
    if (contract_hash_fetched) return;
    contract_hash_storage = env.contractHash();
    contract_hash_fetched = true;
}

/// Verifier params bytes for this invocation. First call traps to
/// `scaffold_env.params`. The returned slice lives in the shim's bump arena
/// (the arena only grows within a run, so the slice stays valid for the
/// remainder of this `run`).
pub fn paramsBytes() []const u8 {
    if (!params_fetched) {
        params_storage = env.params();
        params_fetched = true;
    }
    return params_storage;
}
