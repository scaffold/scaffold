// clock_time_get / clock_res_get -- deterministic clocks.
//
// Mapping (per docs/design/wasi-shim.md#determinism):
//   REALTIME            -> block timestamp (ms) * 1_000_000
//   MONOTONIC           -> strictly-increasing call counter * 1 ns
//   PROCESS_CPUTIME_ID  -> same counter as MONOTONIC
//   THREAD_CPUTIME_ID   -> same counter as MONOTONIC
//
// Resolution is a constant 1 ns for everything -- this is honest about
// how precise our deterministic clocks actually are (call-granularity).
// The `precision` argument to `clock_time_get` is informational; we ignore
// it (the reference implementations all do the same).

const std = @import("std");
const abi = @import("types.zig");
const state = @import("../state.zig");
const prog_mem = @import("../scaffold/prog_mem.zig");

pub fn clock_time_get(clock_id: i32, _: i64, out_time: i32) i32 {
    const value: u64 = switch (clock_id) {
        @intFromEnum(abi.ClockId.REALTIME) => state.cfg.timestamp_ms * 1_000_000,
        @intFromEnum(abi.ClockId.MONOTONIC),
        @intFromEnum(abi.ClockId.PROCESS_CPUTIME_ID),
        @intFromEnum(abi.ClockId.THREAD_CPUTIME_ID),
        => blk: {
            state.monotonic_counter_ns += 1;
            break :blk state.monotonic_counter_ns;
        },
        else => return abi.err(.INVAL),
    };
    prog_mem.store_u64_le(@intCast(out_time), value);
    return abi.ok();
}

pub fn clock_res_get(clock_id: i32, out_resolution: i32) i32 {
    switch (clock_id) {
        @intFromEnum(abi.ClockId.REALTIME),
        @intFromEnum(abi.ClockId.MONOTONIC),
        @intFromEnum(abi.ClockId.PROCESS_CPUTIME_ID),
        @intFromEnum(abi.ClockId.THREAD_CPUTIME_ID),
        => {},
        else => return abi.err(.INVAL),
    }
    prog_mem.store_u64_le(@intCast(out_resolution), 1);
    return abi.ok();
}
