// WASI snapshot preview 1 enums and wire structs.
//
// Mirrored locally rather than re-exported from `std.os.wasi` because:
//   - `std.os.wasi` declares `extern "wasi_snapshot_preview1" fn ...` for
//     every WASI call. The shim *exports* those names; importing the module
//     would risk colliding with our own exports if any reference is added.
//   - Naming conventions differ (`errno_t` vs `Errno`); the audit pins
//     `abi.Errno` etc.
//   - The `extern struct` layouts (Iovec/Fdstat/Filestat) are wasm32-ABI
//     specific and we want to assert their byte sizes here, independent of
//     std layout choices.
//
// Errno numeric values follow WASI snapshot preview 1 (cross-checked against
// `bjorn3/browser_wasi_shim/src/wasi_defs.ts`).

pub const Errno = enum(u16) {
    SUCCESS = 0,
    @"2BIG" = 1,
    ACCES = 2,
    ADDRINUSE = 3,
    ADDRNOTAVAIL = 4,
    AFNOSUPPORT = 5,
    AGAIN = 6,
    ALREADY = 7,
    BADF = 8,
    BADMSG = 9,
    BUSY = 10,
    CANCELED = 11,
    CHILD = 12,
    CONNABORTED = 13,
    CONNREFUSED = 14,
    CONNRESET = 15,
    DEADLK = 16,
    DESTADDRREQ = 17,
    DOM = 18,
    DQUOT = 19,
    EXIST = 20,
    FAULT = 21,
    FBIG = 22,
    HOSTUNREACH = 23,
    IDRM = 24,
    ILSEQ = 25,
    INPROGRESS = 26,
    INTR = 27,
    INVAL = 28,
    IO = 29,
    ISCONN = 30,
    ISDIR = 31,
    LOOP = 32,
    MFILE = 33,
    MLINK = 34,
    MSGSIZE = 35,
    MULTIHOP = 36,
    NAMETOOLONG = 37,
    NETDOWN = 38,
    NETRESET = 39,
    NETUNREACH = 40,
    NFILE = 41,
    NOBUFS = 42,
    NODEV = 43,
    NOENT = 44,
    NOEXEC = 45,
    NOLCK = 46,
    NOLINK = 47,
    NOMEM = 48,
    NOMSG = 49,
    NOPROTOOPT = 50,
    NOSPC = 51,
    NOSYS = 52,
    NOTCONN = 53,
    NOTDIR = 54,
    NOTEMPTY = 55,
    NOTRECOVERABLE = 56,
    NOTSOCK = 57,
    NOTSUP = 58,
    NOTTY = 59,
    NXIO = 60,
    OVERFLOW = 61,
    OWNERDEAD = 62,
    PERM = 63,
    PIPE = 64,
    PROTO = 65,
    PROTONOSUPPORT = 66,
    PROTOTYPE = 67,
    RANGE = 68,
    ROFS = 69,
    SPIPE = 70,
    SRCH = 71,
    STALE = 72,
    TIMEDOUT = 73,
    TXTBSY = 74,
    XDEV = 75,
    NOTCAPABLE = 76,
};

pub const ClockId = enum(u32) {
    REALTIME = 0,
    MONOTONIC = 1,
    PROCESS_CPUTIME_ID = 2,
    THREAD_CPUTIME_ID = 3,
};

pub const Whence = enum(u8) {
    SET = 0,
    CUR = 1,
    END = 2,
};

pub const Filetype = enum(u8) {
    UNKNOWN = 0,
    BLOCK_DEVICE = 1,
    CHARACTER_DEVICE = 2,
    DIRECTORY = 3,
    REGULAR_FILE = 4,
    SOCKET_DGRAM = 5,
    SOCKET_STREAM = 6,
    SYMBOLIC_LINK = 7,
};

pub const Fdflags = packed struct(u16) {
    APPEND: bool = false,
    DSYNC: bool = false,
    NONBLOCK: bool = false,
    RSYNC: bool = false,
    SYNC: bool = false,
    _pad: u11 = 0,
};

pub const Oflags = packed struct(u16) {
    CREAT: bool = false,
    DIRECTORY: bool = false,
    EXCL: bool = false,
    TRUNC: bool = false,
    _pad: u12 = 0,
};

pub const Rights = u64;

pub const RIGHT_FD_DATASYNC: Rights = 0x0000000000000001;
pub const RIGHT_FD_READ: Rights = 0x0000000000000002;
pub const RIGHT_FD_SEEK: Rights = 0x0000000000000004;
pub const RIGHT_FD_FDSTAT_SET_FLAGS: Rights = 0x0000000000000008;
pub const RIGHT_FD_SYNC: Rights = 0x0000000000000010;
pub const RIGHT_FD_TELL: Rights = 0x0000000000000020;
pub const RIGHT_FD_WRITE: Rights = 0x0000000000000040;
pub const RIGHT_FD_ADVISE: Rights = 0x0000000000000080;
pub const RIGHT_FD_ALLOCATE: Rights = 0x0000000000000100;
pub const RIGHT_PATH_CREATE_DIRECTORY: Rights = 0x0000000000000200;
pub const RIGHT_PATH_CREATE_FILE: Rights = 0x0000000000000400;
pub const RIGHT_PATH_LINK_SOURCE: Rights = 0x0000000000000800;
pub const RIGHT_PATH_LINK_TARGET: Rights = 0x0000000000001000;
pub const RIGHT_PATH_OPEN: Rights = 0x0000000000002000;
pub const RIGHT_FD_READDIR: Rights = 0x0000000000004000;
pub const RIGHT_PATH_READLINK: Rights = 0x0000000000008000;
pub const RIGHT_PATH_RENAME_SOURCE: Rights = 0x0000000000010000;
pub const RIGHT_PATH_RENAME_TARGET: Rights = 0x0000000000020000;
pub const RIGHT_PATH_FILESTAT_GET: Rights = 0x0000000000040000;
pub const RIGHT_PATH_FILESTAT_SET_SIZE: Rights = 0x0000000000080000;
pub const RIGHT_PATH_FILESTAT_SET_TIMES: Rights = 0x0000000000100000;
pub const RIGHT_FD_FILESTAT_GET: Rights = 0x0000000000200000;
pub const RIGHT_FD_FILESTAT_SET_SIZE: Rights = 0x0000000000400000;
pub const RIGHT_FD_FILESTAT_SET_TIMES: Rights = 0x0000000000800000;
pub const RIGHT_PATH_SYMLINK: Rights = 0x0000000001000000;
pub const RIGHT_PATH_REMOVE_DIRECTORY: Rights = 0x0000000002000000;
pub const RIGHT_PATH_UNLINK_FILE: Rights = 0x0000000004000000;
pub const RIGHT_POLL_FD_READWRITE: Rights = 0x0000000008000000;
pub const RIGHT_SOCK_SHUTDOWN: Rights = 0x0000000010000000;

pub const Preopentype = enum(u8) {
    DIR = 0,
};

pub const Iovec = extern struct {
    buf: u32,
    buf_len: u32,
};

pub const Ciovec = extern struct {
    buf: u32,
    buf_len: u32,
};

pub const Fdstat = extern struct {
    fs_filetype: Filetype,
    _pad0: u8 = 0,
    fs_flags: Fdflags,
    _pad1: u32 = 0,
    fs_rights_base: Rights,
    fs_rights_inheriting: Rights,
};

pub const Filestat = extern struct {
    dev: u64,
    ino: u64,
    filetype: Filetype,
    _pad: [7]u8 = [_]u8{0} ** 7,
    nlink: u64,
    size: u64,
    atim: u64,
    mtim: u64,
    ctim: u64,
};

comptime {
    const std = @import("std");
    std.debug.assert(@sizeOf(Iovec) == 8);
    std.debug.assert(@sizeOf(Ciovec) == 8);
    std.debug.assert(@sizeOf(Fdstat) == 24);
    std.debug.assert(@sizeOf(Filestat) == 64);
    std.debug.assert(@sizeOf(Fdflags) == 2);
    std.debug.assert(@sizeOf(Oflags) == 2);
}

/// Translate a `vfs.zig` error into a WASI errno. Stub until the vfs error
/// set lands; mapping is filled in alongside `vfs/vfs.zig`.
pub fn errnoFromVfs(err: anytype) Errno {
    _ = err;
    return Errno.NOTSUP;
}
