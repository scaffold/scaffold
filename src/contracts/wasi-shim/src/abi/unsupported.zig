// Stub return for WASI calls that aren't implemented in the current batch.
// Callers shadow this through a single export to keep main.zig small.

const abi = @import("types.zig");

pub inline fn notsup() i32 {
    return abi.err(.NOTSUP);
}
