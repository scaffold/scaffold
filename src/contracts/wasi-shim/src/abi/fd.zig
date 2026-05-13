// File-descriptor WASI snapshot preview 1 calls.
//
// Implements the eleven `fd_*` functions the v1-batch-2 shim ships:
//   fd_write, fd_read, fd_close, fd_seek, fd_tell,
//   fd_fdstat_get, fd_fdstat_set_flags, fd_filestat_get,
//   fd_readdir, fd_prestat_get, fd_prestat_dir_name.
//
// Each call follows the same shape:
//   1. Look up the FdEntry (`state.current().fd_table.get`); BADF on miss.
//   2. Check rights / filetype constraints; return a typed errno on failure.
//   3. Marshal program-memory inputs into a shim staging buffer via
//      `prog_mem.read_*` (one cross-memory hop per chunk).
//   4. Dispatch to the underlying `vfs.Node` vtable.
//   5. Marshal the result back via `prog_mem.write_*` and return SUCCESS.
//
// Per the design (see docs/design/wasi-shim.md "Reference-reconciled
// invariants"): rights mismatches surface as BADF, not EACCES. Out-of-bounds
// program pointers trap from the host import, not errno. Every VfsError is
// translated to a typed Errno via `abi.errnoFromVfs` -- never silently
// swallowed.

const std = @import("std");

const abi = @import("types.zig");
const state = @import("../state.zig");
const prog_mem = @import("../scaffold/prog_mem.zig");
const vfs = @import("../vfs/vfs.zig");

// Single shim-side staging buffer for iovec read/write data. 16 KiB is well
// above wasi-libc's typical writev fanout (~8 iovecs of <512 B each) and lets
// `fd_readdir` produce reasonable batches in one hop. Larger iovecs page-loop.
const STAGING_BUF_BYTES: usize = 16 * 1024;

// Largest iovec table we'll service in one call. wasi-libc never exceeds 16
// in practice; 1024 is a sanity cap that bounds the on-stack buffer (1024 *
// 8 = 8 KiB) and matches the cap declared in `prog_mem.readIovecs`.
const MAX_IOVECS: usize = 1024;

// -- fd_write ----------------------------------------------------------------

pub fn fd_write(fd: i32, iovs_ptr: i32, iovs_len: i32, out_nwritten: i32) i32 {
    if (iovs_len < 0) return errno(.INVAL);
    const n_iovs: usize = @intCast(iovs_len);
    if (n_iovs > MAX_IOVECS) return errno(.INVAL);

    const fd_table = &state.current().fd_table;
    const entry = fd_table.get(fd) orelse return errno(.BADF);
    if ((entry.rights_base & abi.RIGHT_FD_WRITE) == 0) return errno(.BADF);

    // Empty iovec table: SUCCESS with nwritten = 0. Don't touch the node.
    if (n_iovs == 0) {
        prog_mem.writeU32(@intCast(out_nwritten), 0);
        return errno(.SUCCESS);
    }

    var iovs_buf: [MAX_IOVECS]abi.Iovec = undefined;
    prog_mem.readIovecs(@intCast(iovs_ptr), iovs_buf[0..n_iovs]);

    var staging: [STAGING_BUF_BYTES]u8 = undefined;
    var total: u32 = 0;
    var done = false;
    for (iovs_buf[0..n_iovs]) |iov| {
        if (done) break;
        var pulled: u32 = 0;
        while (pulled < iov.buf_len) {
            const remaining = iov.buf_len - pulled;
            const chunk_len: u32 = @intCast(@min(remaining, staging.len));
            prog_mem.readSlice(iov.buf + pulled, staging[0..chunk_len]);
            const written = entry.node.vtable.write(
                entry.node,
                entry.offset,
                staging[0..chunk_len],
            ) catch |err| {
                // If the partial-iovec write failed but earlier iovecs
                // succeeded, report the partial total as SUCCESS and let the
                // next call surface the error -- matches POSIX writev. If
                // *no* bytes have been written yet, the error is the result.
                if (total == 0) return @intFromEnum(abi.errnoFromVfs(err));
                done = true;
                break;
            };
            entry.offset += @intCast(written);
            total += @intCast(written);
            pulled += @intCast(written);
            if (written < chunk_len) {
                // Short write: stop the whole walk so we don't reorder bytes.
                done = true;
                break;
            }
        }
    }

    prog_mem.writeU32(@intCast(out_nwritten), total);
    return errno(.SUCCESS);
}

// -- fd_read -----------------------------------------------------------------

pub fn fd_read(fd: i32, iovs_ptr: i32, iovs_len: i32, out_nread: i32) i32 {
    if (iovs_len < 0) return errno(.INVAL);
    const n_iovs: usize = @intCast(iovs_len);
    if (n_iovs > MAX_IOVECS) return errno(.INVAL);

    const fd_table = &state.current().fd_table;
    const entry = fd_table.get(fd) orelse return errno(.BADF);
    if ((entry.rights_base & abi.RIGHT_FD_READ) == 0) return errno(.BADF);

    if (n_iovs == 0) {
        prog_mem.writeU32(@intCast(out_nread), 0);
        return errno(.SUCCESS);
    }

    var iovs_buf: [MAX_IOVECS]abi.Iovec = undefined;
    prog_mem.readIovecs(@intCast(iovs_ptr), iovs_buf[0..n_iovs]);

    var staging: [STAGING_BUF_BYTES]u8 = undefined;
    var total: u32 = 0;
    var hit_eof = false;
    for (iovs_buf[0..n_iovs]) |iov| {
        if (hit_eof) break;
        var pushed: u32 = 0;
        while (pushed < iov.buf_len) {
            const remaining = iov.buf_len - pushed;
            const chunk_len: u32 = @intCast(@min(remaining, staging.len));
            const got = entry.node.vtable.read(
                entry.node,
                entry.offset,
                staging[0..chunk_len],
            ) catch |err| {
                // Same partial-on-error semantics as fd_write: if anything
                // has already been read, report the partial total; otherwise
                // surface the typed errno.
                if (total == 0) return @intFromEnum(abi.errnoFromVfs(err));
                hit_eof = true;
                break;
            };
            if (got == 0) {
                // EOF -- stop the walk; total is whatever we've read so far.
                hit_eof = true;
                break;
            }
            prog_mem.writeSlice(iov.buf + pushed, staging[0..got]);
            entry.offset += @intCast(got);
            total += @intCast(got);
            pushed += @intCast(got);
            if (got < chunk_len) {
                // Short read mid-iovec: source has more bytes but not enough
                // to fill the chunk. Don't keep pulling on this iovec --
                // POSIX `read` returns the short count and lets the caller
                // re-issue.
                hit_eof = true;
                break;
            }
        }
    }

    prog_mem.writeU32(@intCast(out_nread), total);
    return errno(.SUCCESS);
}

// -- fd_close ----------------------------------------------------------------

pub fn fd_close(fd: i32) i32 {
    const fd_table = &state.current().fd_table;
    const entry = fd_table.get(fd) orelse return errno(.BADF);

    // Preopens cannot be closed in our model -- closing a preopen would leave
    // wasi-libc walking past it on the next prestat scan. Stdio FDs (0/1/2)
    // ARE closeable per the WASI spec (some daemons close stderr).
    if (entry.preopen_path != null) return errno(.NOTCAPABLE);

    // Order: capture the node, run the node-side close (which may emit
    // outputs / call reject), then null the slot. If the close traps, the
    // slot is still occupied -- the auto-close pass at run() exit will not
    // re-fire because it iterates `entries[i]` linearly and the slot is
    // already null after the successful path. A trap aborts the program
    // anyway.
    const node = entry.node;
    node.vtable.close(node);
    fd_table.free(@intCast(fd)) catch return errno(.BADF);
    return errno(.SUCCESS);
}

// -- fd_seek -----------------------------------------------------------------

pub fn fd_seek(fd: i32, offset: i64, whence: i32, out_new_offset: i32) i32 {
    const fd_table = &state.current().fd_table;
    const entry = fd_table.get(fd) orelse return errno(.BADF);

    // Rights check: FD_SEEK normally; the "tell shortcut"
    // (whence=CUR, offset=0) is also accepted under FD_TELL alone -- this
    // is the path wasi-libc takes for `ftell()`.
    const has_seek = (entry.rights_base & abi.RIGHT_FD_SEEK) != 0;
    const is_tell_shortcut = whence == @intFromEnum(abi.Whence.CUR) and offset == 0;
    const has_tell = (entry.rights_base & abi.RIGHT_FD_TELL) != 0;
    if (!has_seek and !(is_tell_shortcut and has_tell)) return errno(.BADF);

    // Filetype check next: streams are non-seekable. Character devices
    // (`/dev/random`, `/dev/zero`, `/dev/null`, `/out/debug`) and stdio
    // bound to them all report CHARACTER_DEVICE in their stat.
    const stat_res = entry.node.vtable.stat(entry.node) catch |err|
        return @intFromEnum(abi.errnoFromVfs(err));
    if (stat_res.filetype == .CHARACTER_DEVICE) return errno(.SPIPE);
    if (stat_res.filetype == .DIRECTORY) return errno(.ISDIR);

    // Whence validation up-front so the math doesn't need a default arm.
    if (whence < 0 or whence > 2) return errno(.INVAL);
    const w: abi.Whence = @enumFromInt(@as(u8, @intCast(whence)));

    // i128 intermediates dodge the JS-Number precision bug in WasiImpl.ts.
    const base: i128 = switch (w) {
        .SET => 0,
        .CUR => @intCast(entry.offset),
        .END => @intCast(stat_res.size),
    };
    const computed: i128 = base + @as(i128, offset);
    if (computed < 0) return errno(.INVAL);
    if (computed > std.math.maxInt(i64)) return errno(.INVAL);

    const new_offset: u64 = @intCast(computed);
    entry.offset = new_offset;
    prog_mem.writeU64(@intCast(out_new_offset), new_offset);
    return errno(.SUCCESS);
}

// -- fd_tell -----------------------------------------------------------------

pub fn fd_tell(fd: i32, out_offset: i32) i32 {
    // ftell(fd) === fd_seek(fd, 0, CUR, &out). Same errno semantics.
    return fd_seek(fd, 0, @intFromEnum(abi.Whence.CUR), out_offset);
}

// -- fd_fdstat_get -----------------------------------------------------------

pub fn fd_fdstat_get(fd: i32, out_stat: i32) i32 {
    const fd_table = &state.current().fd_table;
    const entry = fd_table.get(fd) orelse return errno(.BADF);

    const stat_res = entry.node.vtable.stat(entry.node) catch |err|
        return @intFromEnum(abi.errnoFromVfs(err));

    var buf: [@sizeOf(abi.Fdstat)]u8 = undefined;
    serializeFdstat(&buf, .{
        .filetype = vfsToWasiFiletype(stat_res.filetype),
        .fdflags = entry.fdflags,
        .rights_base = entry.rights_base,
        .rights_inheriting = entry.rights_inheriting,
    });
    prog_mem.writeSlice(@intCast(out_stat), &buf);
    return errno(.SUCCESS);
}

// -- fd_fdstat_set_flags -----------------------------------------------------

/// Mask of the five defined Fdflags bits (APPEND, DSYNC, NONBLOCK, RSYNC, SYNC).
/// Anything outside this mask in a `set_flags` call ⇒ INVAL.
const FDFLAGS_DEFINED_MASK: u16 = 0b0001_1111;
/// Subset that the shim actually stores. DSYNC/RSYNC/SYNC are silently
/// ignored per `fd_fdstat_set_flags` decision #1.
const FDFLAGS_STORED_MASK: u16 = 0b0000_0101; // APPEND | NONBLOCK

pub fn fd_fdstat_set_flags(fd: i32, fdflags: i32) i32 {
    const fd_table = &state.current().fd_table;
    const entry = fd_table.get(fd) orelse return errno(.BADF);

    // Reject unknown high bits up-front. wasi-libc only ever passes the
    // five defined bits; anything else is a contract bug worth surfacing.
    const bits: u32 = @bitCast(fdflags);
    if (bits > std.math.maxInt(u16)) return errno(.INVAL);
    const flags: u16 = @intCast(bits);
    if ((flags & ~FDFLAGS_DEFINED_MASK) != 0) return errno(.INVAL);

    // Drop DSYNC/RSYNC/SYNC silently; only APPEND + NONBLOCK survive.
    entry.fdflags = (entry.fdflags & ~FDFLAGS_STORED_MASK) |
        (flags & FDFLAGS_STORED_MASK);
    return errno(.SUCCESS);
}

// -- fd_filestat_get ---------------------------------------------------------

pub fn fd_filestat_get(fd: i32, out_stat: i32) i32 {
    const fd_table = &state.current().fd_table;
    const entry = fd_table.get(fd) orelse return errno(.BADF);

    const stat_res = entry.node.vtable.stat(entry.node) catch |err|
        return @intFromEnum(abi.errnoFromVfs(err));

    const ts_ns: u64 = state.current().timestamp_ms * 1_000_000;
    const filetype = vfsToWasiFiletype(stat_res.filetype);
    var buf: [@sizeOf(abi.Filestat)]u8 = undefined;
    serializeFilestat(&buf, .{
        .dev = 0,
        // Inode is left at 0 -- matches what wasmtime does for memfs and
        // sidesteps the path-hash collision question for v1. Programs that
        // care (CPython's import cache) only require stable per-FD ino, not
        // unique-across-paths; same FD + same path ⇒ same ino (both 0).
        .ino = 0,
        .filetype = filetype,
        // POSIX convention: directories report nlink >= 2 (self + .. from
        // any subdir). Programs use this to detect "is this a directory".
        .nlink = if (filetype == .DIRECTORY) 2 else 1,
        .size = stat_res.size,
        .atim = ts_ns,
        .mtim = ts_ns,
        .ctim = ts_ns,
    });
    prog_mem.writeSlice(@intCast(out_stat), &buf);
    return errno(.SUCCESS);
}

// -- fd_readdir --------------------------------------------------------------

/// WASI dirent header: u64 d_next, u64 d_ino, u32 d_namlen, u8 d_type, plus
/// 3 bytes of pad to round out 24. Name bytes follow immediately with no
/// alignment between header and name; the next dirent starts unaligned right
/// after the name. wasi-libc reassembles via namelen offsets.
const DIRENT_HEADER_BYTES: usize = 24;

pub fn fd_readdir(fd: i32, buf: i32, buf_len: i32, cookie: i64, out_bytes_used: i32) i32 {
    if (buf_len < 0) return errno(.INVAL);
    const buf_capacity: u32 = @intCast(buf_len);

    const fd_table = &state.current().fd_table;
    const entry = fd_table.get(fd) orelse return errno(.BADF);

    const stat_res = entry.node.vtable.stat(entry.node) catch |err|
        return @intFromEnum(abi.errnoFromVfs(err));
    if (stat_res.filetype != .DIRECTORY) return errno(.NOTDIR);

    const readdir_fn = entry.node.vtable.readdir orelse return errno(.NOTSUP);

    var staging: [STAGING_BUF_BYTES]u8 = undefined;
    var written: u32 = 0;
    var next_cookie: u64 = @bitCast(cookie);

    // Pull entries one at a time so we can stop the moment the program
    // buffer fills (or its current entry is truncated). Walking in batches
    // would force us to discard any unused tail, wasting cookies.
    var single: [1]vfs.DirEntry = undefined;
    while (written < buf_capacity) {
        const got = readdir_fn(entry.node, next_cookie, single[0..]) catch |err|
            return @intFromEnum(abi.errnoFromVfs(err));
        if (got == 0) break; // no more entries -- EOF will be signalled by
        // `written < buf_capacity` (per the spec's "less than buf_len = end"
        // rule).

        const de = single[0];
        const total_record = DIRENT_HEADER_BYTES + de.name.len;
        const room = buf_capacity - written;

        // Header always serialised in full (or as much as fits).
        var header: [DIRENT_HEADER_BYTES]u8 = undefined;
        serializeDirent(&header, .{
            .d_next = next_cookie + 1,
            .d_ino = 0,
            .d_namlen = @intCast(de.name.len),
            .d_type = @intFromEnum(vfsToWasiFiletype(de.filetype)),
        });

        if (room >= total_record) {
            // Whole entry fits. Coalesce header + name into one staging
            // block when possible (one write hop); otherwise write the
            // header and the name separately. >16 KiB filenames are
            // pathological but legal in WASI.
            const dst_off: u32 = @as(u32, @intCast(buf)) + written;
            if (total_record <= staging.len) {
                @memcpy(staging[0..DIRENT_HEADER_BYTES], &header);
                @memcpy(staging[DIRENT_HEADER_BYTES..total_record], de.name);
                prog_mem.writeSlice(@intCast(dst_off), staging[0..total_record]);
            } else {
                prog_mem.writeSlice(@intCast(dst_off), &header);
                prog_mem.writeSlice(@intCast(dst_off + DIRENT_HEADER_BYTES), de.name);
            }
            written += @intCast(total_record);
            next_cookie += 1;
        } else {
            // Truncation: write whatever fits of (header || name), set
            // bytes_used = buf_capacity. Per `fd_readdir` decision #6: this
            // signals "more data available; call again with the same cookie".
            // We do NOT bump `next_cookie` past the truncated entry.
            const header_fit = @min(room, DIRENT_HEADER_BYTES);
            prog_mem.writeSlice(@intCast(@as(u32, @intCast(buf)) + written), header[0..header_fit]);
            written += header_fit;
            const name_room = buf_capacity - written;
            if (name_room > 0) {
                const name_fit = @min(name_room, de.name.len);
                prog_mem.writeSlice(
                    @intCast(@as(u32, @intCast(buf)) + written),
                    de.name[0..name_fit],
                );
                written += name_fit;
            }
            // Force `written == buf_capacity` so the spec's
            // "less-than-buf-size = EOF" rule signals "more available".
            std.debug.assert(written == buf_capacity);
            break;
        }
    }

    prog_mem.writeU32(@intCast(out_bytes_used), written);
    return errno(.SUCCESS);
}

// -- fd_prestat_get ----------------------------------------------------------

/// 8-byte prestat header for directory preopens. tag=0 (DIR), 3 bytes pad,
/// then u32 LE name_len.
const PRESTAT_BYTES: usize = 8;

pub fn fd_prestat_get(fd: i32, out_prestat: i32) i32 {
    const fd_table = &state.current().fd_table;
    const entry = fd_table.get(fd) orelse return errno(.BADF);

    // wasi-libc walks fds 3, 4, ... calling prestat_get; the first BADF
    // signals "no more preopens". Non-preopen FDs (path_open results) hit
    // the same path -- BADF terminates the walk cleanly.
    const path = entry.preopen_path orelse return errno(.BADF);

    var buf: [PRESTAT_BYTES]u8 = undefined;
    @memset(&buf, 0);
    buf[0] = @intFromEnum(abi.Preopentype.DIR);
    std.mem.writeInt(u32, buf[4..8], @intCast(path.len), .little);
    prog_mem.writeSlice(@intCast(out_prestat), &buf);
    return errno(.SUCCESS);
}

// -- fd_prestat_dir_name -----------------------------------------------------

pub fn fd_prestat_dir_name(fd: i32, buf: i32, buf_len: i32) i32 {
    if (buf_len < 0) return errno(.INVAL);
    const capacity: u32 = @intCast(buf_len);

    const fd_table = &state.current().fd_table;
    const entry = fd_table.get(fd) orelse return errno(.BADF);
    const path = entry.preopen_path orelse return errno(.BADF);

    // Match bjorn3/browser_wasi_shim: short buffer ⇒ NAMETOOLONG (no silent
    // truncation, which wasmtime does). Programs that care can re-issue with
    // a larger buffer using `fd_prestat_get`'s reported length.
    if (capacity < path.len) return errno(.NAMETOOLONG);

    prog_mem.writeSlice(@intCast(buf), path);
    return errno(.SUCCESS);
}

// -- struct serialisers ------------------------------------------------------
//
// These are pure functions: they take an in-memory output buffer and a
// struct of values, and write little-endian bytes. Called from the abi
// dispatchers above; also exported for native unit testing.

pub const FdstatLayout = struct {
    filetype: abi.Filetype,
    fdflags: u16,
    rights_base: u64,
    rights_inheriting: u64,
};

pub fn serializeFdstat(out: *[@sizeOf(abi.Fdstat)]u8, layout: FdstatLayout) void {
    @memset(out, 0); // zero pad bytes (offsets 1, 4..8) deterministically.
    out[0] = @intFromEnum(layout.filetype);
    std.mem.writeInt(u16, out[2..4], layout.fdflags, .little);
    std.mem.writeInt(u64, out[8..16], layout.rights_base, .little);
    std.mem.writeInt(u64, out[16..24], layout.rights_inheriting, .little);
}

pub const FilestatLayout = struct {
    dev: u64,
    ino: u64,
    filetype: abi.Filetype,
    nlink: u64,
    size: u64,
    atim: u64,
    mtim: u64,
    ctim: u64,
};

pub fn serializeFilestat(out: *[@sizeOf(abi.Filestat)]u8, layout: FilestatLayout) void {
    @memset(out, 0); // zero pad bytes (offsets 17..24) deterministically.
    std.mem.writeInt(u64, out[0..8], layout.dev, .little);
    std.mem.writeInt(u64, out[8..16], layout.ino, .little);
    out[16] = @intFromEnum(layout.filetype);
    std.mem.writeInt(u64, out[24..32], layout.nlink, .little);
    std.mem.writeInt(u64, out[32..40], layout.size, .little);
    std.mem.writeInt(u64, out[40..48], layout.atim, .little);
    std.mem.writeInt(u64, out[48..56], layout.mtim, .little);
    std.mem.writeInt(u64, out[56..64], layout.ctim, .little);
}

pub const DirentLayout = struct {
    d_next: u64,
    d_ino: u64,
    d_namlen: u32,
    d_type: u8,
};

pub fn serializeDirent(out: *[DIRENT_HEADER_BYTES]u8, layout: DirentLayout) void {
    @memset(out, 0); // zero the 3-byte pad after d_type.
    std.mem.writeInt(u64, out[0..8], layout.d_next, .little);
    std.mem.writeInt(u64, out[8..16], layout.d_ino, .little);
    std.mem.writeInt(u32, out[16..20], layout.d_namlen, .little);
    out[20] = layout.d_type;
}

// -- helpers -----------------------------------------------------------------

/// Translate the vfs filetype enum to the abi enum. Distinct types because
/// vfs is intentionally WASI-agnostic; the enum values happen to coincide
/// today but the indirection keeps that an implementation detail.
pub fn vfsToWasiFiletype(ft: vfs.Filetype) abi.Filetype {
    return switch (ft) {
        .UNKNOWN => .UNKNOWN,
        .BLOCK_DEVICE => .BLOCK_DEVICE,
        .CHARACTER_DEVICE => .CHARACTER_DEVICE,
        .DIRECTORY => .DIRECTORY,
        .REGULAR_FILE => .REGULAR_FILE,
        .SYMBOLIC_LINK => .SYMBOLIC_LINK,
    };
}

inline fn errno(e: abi.Errno) i32 {
    return @intFromEnum(e);
}

// -- tests -------------------------------------------------------------------
//
// These exercise the pure helpers (struct serialisers, filetype mapping,
// flag-mask logic). The full call paths (fd_write/read/seek/etc.) bottom out
// in `prog_mem.*` which is unresolvable in native test builds; those paths
// land in the Phase E contract-trace snapshot suite.

const testing = std.testing;

test "serializeFdstat zero-pads and lays out bytes per spec" {
    var buf: [@sizeOf(abi.Fdstat)]u8 = undefined;
    @memset(&buf, 0xAA); // poison; serializer must zero pad bytes
    serializeFdstat(&buf, .{
        .filetype = .REGULAR_FILE,
        .fdflags = 0x0005, // APPEND | NONBLOCK
        .rights_base = 0x0123_4567_89AB_CDEF,
        .rights_inheriting = 0xFEDC_BA98_7654_3210,
    });

    try testing.expectEqual(@as(u8, 4), buf[0]); // REGULAR_FILE
    try testing.expectEqual(@as(u8, 0), buf[1]); // pad
    try testing.expectEqual(@as(u16, 0x0005), std.mem.readInt(u16, buf[2..4], .little));
    // 4-byte pad before rights_base must be zeroed.
    try testing.expectEqual(@as(u32, 0), std.mem.readInt(u32, buf[4..8], .little));
    try testing.expectEqual(
        @as(u64, 0x0123_4567_89AB_CDEF),
        std.mem.readInt(u64, buf[8..16], .little),
    );
    try testing.expectEqual(
        @as(u64, 0xFEDC_BA98_7654_3210),
        std.mem.readInt(u64, buf[16..24], .little),
    );
}

test "serializeFilestat lays out 64 bytes with zero pads" {
    var buf: [@sizeOf(abi.Filestat)]u8 = undefined;
    @memset(&buf, 0xAA);
    serializeFilestat(&buf, .{
        .dev = 1,
        .ino = 2,
        .filetype = .DIRECTORY,
        .nlink = 2,
        .size = 4096,
        .atim = 100,
        .mtim = 200,
        .ctim = 300,
    });

    try testing.expectEqual(@as(u64, 1), std.mem.readInt(u64, buf[0..8], .little));
    try testing.expectEqual(@as(u64, 2), std.mem.readInt(u64, buf[8..16], .little));
    try testing.expectEqual(@as(u8, 3), buf[16]); // DIRECTORY
    // Pad bytes 17..24 must be zero.
    for (buf[17..24]) |b| try testing.expectEqual(@as(u8, 0), b);
    try testing.expectEqual(@as(u64, 2), std.mem.readInt(u64, buf[24..32], .little));
    try testing.expectEqual(@as(u64, 4096), std.mem.readInt(u64, buf[32..40], .little));
    try testing.expectEqual(@as(u64, 100), std.mem.readInt(u64, buf[40..48], .little));
    try testing.expectEqual(@as(u64, 200), std.mem.readInt(u64, buf[48..56], .little));
    try testing.expectEqual(@as(u64, 300), std.mem.readInt(u64, buf[56..64], .little));
}

test "serializeDirent encodes 24-byte header in spec order" {
    var buf: [DIRENT_HEADER_BYTES]u8 = undefined;
    @memset(&buf, 0xAA);
    serializeDirent(&buf, .{
        .d_next = 5,
        .d_ino = 99,
        .d_namlen = 7,
        .d_type = @intFromEnum(abi.Filetype.REGULAR_FILE),
    });

    try testing.expectEqual(@as(u64, 5), std.mem.readInt(u64, buf[0..8], .little));
    try testing.expectEqual(@as(u64, 99), std.mem.readInt(u64, buf[8..16], .little));
    try testing.expectEqual(@as(u32, 7), std.mem.readInt(u32, buf[16..20], .little));
    try testing.expectEqual(@as(u8, 4), buf[20]);
    // 3-byte pad (offsets 21..24) must be zero.
    for (buf[21..24]) |b| try testing.expectEqual(@as(u8, 0), b);
}

test "vfsToWasiFiletype covers every vfs variant" {
    try testing.expectEqual(abi.Filetype.UNKNOWN, vfsToWasiFiletype(.UNKNOWN));
    try testing.expectEqual(abi.Filetype.BLOCK_DEVICE, vfsToWasiFiletype(.BLOCK_DEVICE));
    try testing.expectEqual(abi.Filetype.CHARACTER_DEVICE, vfsToWasiFiletype(.CHARACTER_DEVICE));
    try testing.expectEqual(abi.Filetype.DIRECTORY, vfsToWasiFiletype(.DIRECTORY));
    try testing.expectEqual(abi.Filetype.REGULAR_FILE, vfsToWasiFiletype(.REGULAR_FILE));
    try testing.expectEqual(abi.Filetype.SYMBOLIC_LINK, vfsToWasiFiletype(.SYMBOLIC_LINK));
}

test "FDFLAGS_DEFINED_MASK matches the union of the 5 spec bits" {
    // APPEND(1) | DSYNC(2) | NONBLOCK(4) | RSYNC(8) | SYNC(16) = 31.
    try testing.expectEqual(@as(u16, 0b0001_1111), FDFLAGS_DEFINED_MASK);
    // Stored mask is APPEND + NONBLOCK only.
    try testing.expectEqual(@as(u16, 0b0000_0101), FDFLAGS_STORED_MASK);
    // Stored bits are a subset of defined bits.
    try testing.expect((FDFLAGS_STORED_MASK & ~FDFLAGS_DEFINED_MASK) == 0);
}

test "DIRENT_HEADER_BYTES matches the spec layout sum" {
    // u64 + u64 + u32 + u8 + 3 pad = 24.
    try testing.expectEqual(@as(usize, 24), DIRENT_HEADER_BYTES);
}

test "PRESTAT_BYTES matches the wasi prestat-dir layout" {
    // u8 tag + 3 pad + u32 name_len = 8.
    try testing.expectEqual(@as(usize, 8), PRESTAT_BYTES);
}

test "fdflags mask logic: APPEND alone passes through, DSYNC dropped" {
    // Simulate `fd_fdstat_set_flags(fd, APPEND | DSYNC)`:
    const incoming: u16 = 0b0000_0011; // APPEND | DSYNC
    try testing.expect((incoming & ~FDFLAGS_DEFINED_MASK) == 0); // accepted
    const stored = incoming & FDFLAGS_STORED_MASK;
    try testing.expectEqual(@as(u16, 0b0000_0001), stored); // DSYNC dropped
}

test "fdflags mask logic: high bits get rejected" {
    const bad: u16 = 0b1000_0000; // bit 7 -- not a defined fdflag
    try testing.expect((bad & ~FDFLAGS_DEFINED_MASK) != 0);
}
