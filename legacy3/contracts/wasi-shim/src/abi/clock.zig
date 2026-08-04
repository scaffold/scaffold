// WASI clock_time_get / clock_res_get. All times are deterministic --
// REALTIME from block ts (fetched lazily), MONOTONIC from per-call counter.

const abi = @import("types.zig");
const state = @import("../state.zig");
const lazy_inputs = @import("../scaffold/lazy_inputs.zig");
const prog_mem = @import("../scaffold/prog_mem.zig");

pub fn clock_time_get(clock_id: i32, precision: i64, out_time: i32) i32 {
    _ = precision;
    const s = state.current();
    const ns: u64 = switch (clock_id) {
        @intFromEnum(abi.ClockId.REALTIME) => lazy_inputs.timestampMs() * 1_000_000,
        @intFromEnum(abi.ClockId.MONOTONIC),
        @intFromEnum(abi.ClockId.PROCESS_CPUTIME_ID),
        @intFromEnum(abi.ClockId.THREAD_CPUTIME_ID),
        => blk: {
            s.monotonic_counter += 1;
            break :blk s.monotonic_counter;
        },
        else => return @intFromEnum(abi.Errno.INVAL),
    };
    prog_mem.writeU64(@intCast(out_time), ns);
    return @intFromEnum(abi.Errno.SUCCESS);
}

pub fn clock_res_get(clock_id: i32, out_resolution: i32) i32 {
    switch (clock_id) {
        @intFromEnum(abi.ClockId.REALTIME),
        @intFromEnum(abi.ClockId.MONOTONIC),
        @intFromEnum(abi.ClockId.PROCESS_CPUTIME_ID),
        @intFromEnum(abi.ClockId.THREAD_CPUTIME_ID),
        => {},
        else => return @intFromEnum(abi.Errno.INVAL),
    }
    prog_mem.writeU64(@intCast(out_resolution), 1);
    return @intFromEnum(abi.Errno.SUCCESS);
}

// No native tests: both functions call into `prog_mem.writeU64`, which calls
// the `program_mem.write_bytes` extern from main.zig -- only resolvable by the
// stacking linker at runtime. The contract-trace snapshot tests in Phase E
// exercise this end-to-end.
