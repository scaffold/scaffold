// proc_exit / proc_raise -- WASI process-control calls.
//
// `proc_exit` cannot literally return through the program's call stack from
// arbitrary depth, so we hijack the rejection path: every exit calls
// `scaffold_env.reject`. A clean exit (`rval == 0`) emits the magic reason
// `EXIT_ZERO_REASON`; the TS-side run wrapper recognises that exact string and
// converts the resulting trap into a normal `run` return. Any other reason --
// including `proc_exit(n != 0)` and `proc_raise` -- surfaces as a real
// `ContractRejection`. See "Other Implementation Notes" §2 in
// `docs/design/wasi-shim.md`.

const std = @import("std");
const env = @import("../scaffold/env.zig");

pub const EXIT_ZERO_REASON: []const u8 = "__SCAFFOLD_WASI_EXIT_ZERO__";

pub fn proc_exit(rval: i32) noreturn {
    if (rval == 0) {
        env.reject(EXIT_ZERO_REASON);
    } else {
        var buf: [40]u8 = undefined;
        const msg = std.fmt.bufPrint(&buf, "WASI proc_exit: {d}", .{rval}) catch unreachable;
        env.reject(msg);
    }
}

pub fn proc_raise(sig: i32) noreturn {
    var buf: [40]u8 = undefined;
    const msg = std.fmt.bufPrint(&buf, "WASI proc_raise: {d}", .{sig}) catch unreachable;
    env.reject(msg);
}
