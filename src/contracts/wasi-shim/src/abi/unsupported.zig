// Errno helpers for stubs the shim does not (yet) implement. Keeps call
// sites in `main.zig` short and avoids re-typing `@intFromEnum` everywhere.
// Also the home for stubs that return a more specific errno than NOTSUP
// (e.g. EROFS for `path_symlink` outside `/scratch`).

const abi = @import("types.zig");

pub inline fn notsup() i32 {
    return @intFromEnum(abi.Errno.NOTSUP);
}

pub inline fn errno(e: abi.Errno) i32 {
    return @intFromEnum(e);
}
