// WASI snapshot preview 1 wire types -- the subset our v1 batch needs.
// Numeric values are from `bjorn3/browser_wasi_shim`'s wasi_defs.ts (which
// matches the spec). When extending, prefer adding here over scattering
// magic numbers across abi/.

pub const Errno = enum(u16) {
    SUCCESS = 0,
    AGAIN = 6,
    BADF = 8,
    EXIST = 20,
    INVAL = 28,
    ISDIR = 31,
    NAMETOOLONG = 37,
    NOENT = 44,
    NOTDIR = 54,
    NOTSUP = 58,
    PERM = 63,
    PIPE = 64,
    NOTCAPABLE = 76,
};

pub const ClockId = enum(u32) {
    REALTIME = 0,
    MONOTONIC = 1,
    PROCESS_CPUTIME_ID = 2,
    THREAD_CPUTIME_ID = 3,
    _,
};

/// Subset of `fdflags_t`. Only the ones our handlers actually inspect.
pub const FdFlags = packed struct(u16) {
    append: bool = false,
    dsync: bool = false,
    nonblock: bool = false,
    rsync: bool = false,
    sync: bool = false,
    _pad: u11 = 0,
};

/// Subset of `oflags_t`.
pub const OFlags = packed struct(u16) {
    creat: bool = false,
    directory: bool = false,
    excl: bool = false,
    trunc: bool = false,
    _pad: u12 = 0,
};

/// Helper for export functions returning `i32` from an `Errno`.
pub inline fn ok() i32 {
    return @intFromEnum(Errno.SUCCESS);
}

pub inline fn err(e: Errno) i32 {
    return @intFromEnum(e);
}
