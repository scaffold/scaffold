// proc_exit / proc_raise.
//
// Determinism contract:
//   - proc_exit(0) returns control to the shim's `run`, which exits normally.
//   - proc_exit(n != 0) calls scaffold_env.reject("WASI proc_exit: <n>") which
//     traps; the contract surfaces a ContractRejection with that reason.
//   - proc_raise is permanently ENOTSUP. Real WASI engines either no-op or
//     ENOTSUP it; signal delivery to a deterministic contract is meaningless.
//
// The WASI spec marks proc_exit `[noreturn]`. We honour that even for the
// exit(0) path by raising the special `__exit_zero` sentinel error and
// catching it at the run boundary -- this matches wasmtime's strategy of
// using a typed trap so the host knows whether to abort or unwind.

const std = @import("std");
const abi = @import("types.zig");

// Imports from main module so we can call back into scaffold.
const main = @import("../main.zig");

/// Magic reason the program._start wrapper recognises and swallows so the
/// shim's `run` returns normally to scaffold. Anything else surfaces as a
/// real ContractRejection.
pub const EXIT_ZERO_REASON = "__SCAFFOLD_WASI_EXIT_ZERO__";

pub fn proc_exit(rval: i32) noreturn {
    if (rval == 0) {
        main.reject(
            @intCast(@intFromPtr(EXIT_ZERO_REASON.ptr)),
            @intCast(EXIT_ZERO_REASON.len),
        );
        unreachable;
    }
    var buf: [40]u8 = undefined;
    const written = std.fmt.bufPrint(&buf, "WASI proc_exit: {d}", .{rval}) catch unreachable;
    main.reject(@intCast(@intFromPtr(written.ptr)), @intCast(written.len));
    unreachable;
}

pub fn proc_raise(_: i32) i32 {
    return abi.err(.NOTSUP);
}
