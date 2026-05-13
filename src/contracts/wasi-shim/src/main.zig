// WASI snapshot preview 1 shim. Translates the WASI host surface into
// `scaffold_env` calls, running as one layer in a Scaffold stacking graph.
//
// See `docs/design/wasi-shim.md` for the full design rationale, especially
// the cross-memory accessor decision (the shim never imports the program's
// memory directly; it copies via the imported `program_mem.read_bytes` /
// `program_mem.write_bytes` helpers).
//
// Layout of this file:
//   - imports        — scaffold_env.*, program.*, program_mem.*
//   - exports        — `run` (scaffold entry) and `alloc` (the standard
//                      ABI alloc bumper the run bridge needs)
//   - WASI exports   — `args_get`, `proc_exit`, ... wired up function by
//                      function. Order matches WASI snapshot preview 1.
//
// Calls land here flat: the program imports `wasi_snapshot_preview1.fd_write`
// and the stacking linker resolves it to our exported `fd_write` via the
// `wasi_snapshot_preview1.*: wasi_shim:*` wildcard in the program's imports.

const std = @import("std");

const abi = @import("abi/types.zig");
const proc = @import("abi/proc.zig");
const clock = @import("abi/clock.zig");
const random_abi = @import("abi/random.zig");
const args_env = @import("abi/args_env.zig");
const fd_mod = @import("abi/fd.zig");
const path_mod = @import("abi/path.zig");
const unsupported = @import("abi/unsupported.zig");
const state = @import("state.zig");
const env = @import("scaffold/env.zig");
const paths = @import("scaffold/paths.zig");
const setup = @import("scaffold/setup.zig");

// -- scaffold_env imports --------------------------------------------
//
// These match the flat-export surface declared in `WasmHostBridge.ts`.
// `i64` return values are `packPtrLen` results (high 32 = ptr, low 32 = len)
// pointing into THIS module's memory.

pub extern "scaffold_env" fn mode() i32;
pub extern "scaffold_env" fn timestamp() i64;
pub extern "scaffold_env" fn params() i64;
pub extern "scaffold_env" fn contract_hash() i64;
// `contract_metadata` returns an empty (`len == 0`) reply when the requested
// record is absent on the contract block (the host bridge converts the typed
// `ContractRejection` into this empty wire reply). Callers (env.zig +
// setup.zig) treat both an empty reply and a present-but-empty body as
// "use defaults" so the shim doesn't trap on a missing record. Any other
// reply is a normal `(value, body)` payload.
pub extern "scaffold_env" fn contract_metadata(vp: i32, vl: i32) i64;
pub extern "scaffold_env" fn emit_output(op: i32, ol: i32) void;
pub extern "scaffold_env" fn request_body(vp: i32, vl: i32) i64;
pub extern "scaffold_env" fn fetch(vp: i32, vl: i32, kp: i32, kl: i32) i64;
// Diagnostic-only sink for `/out/debug`. Host forwards to `ctx.logger` (or
// silently drops if no logger is wired). Bytes are UTF-8.
pub extern "scaffold_env" fn debug(rp: i32, rl: i32) void;
pub extern "scaffold_env" fn reject(rp: i32, rl: i32) void;

// -- program imports -------------------------------------------------
//
// `program._start` is wired in the contract's modules graph and invoked once
// from `run`. The shim's `proc_exit` traps via `scaffold_env.reject`, so
// nonzero exits surface as rejections; zero exits unwind cleanly here.

pub extern "program" fn _start() void;

// -- program_mem accessor helpers ------------------------------------
//
// The linker provides JS closures that memcpy between this module's memory
// and the program layer's memory. The shim never sees the program's memory
// as a wasm memory index; it uses these helpers exclusively.
//
// Both take (prog_off, shim_off, len). `read_bytes` pulls FROM the program
// memory into the shim's memory; `write_bytes` pushes the opposite way.

pub extern "program_mem" fn read_bytes(prog_off: i32, shim_dst: i32, len: i32) void;
pub extern "program_mem" fn write_bytes(prog_off: i32, shim_src: i32, len: i32) void;

// -- shim-side allocator -----------------------------------------------
//
// The contract ABI expects an exported `alloc(size) -> ptr` that the host
// uses to stage bytes into the contract's memory (e.g. when scaffold returns
// `params()` to us). It's a bump allocator -- no free. Reset each `run`.
//
// Start address: 2 MiB. This is comfortably above
//   - the Zig stack (lives below __stack_pointer = 1 MiB by wasm-ld default)
//   - the .rodata + .data + BSS region (loaded at 1 MiB; ~12 KiB total
//     today, dominated by the global `current_state`).
// Putting bump below ~1.1 MiB silently overwrites BSS / rodata — caused a
// week of "memory access out of bounds" mystery before we caught it. Any
// future bump to BSS (e.g. growing FdTable) doesn't need a corresponding
// bump here as long as BSS stays under 1 MiB.
const BUMP_START: u32 = 2 * 1024 * 1024;
var bump_ptr: u32 = BUMP_START;

export fn alloc(size: i32) i32 {
    // 16-byte alignment is plenty for everything we stage (verifier bytes,
    // request bodies, output records). Wire-format codecs assume LE u32/u64
    // alignment at worst. `0xF` as a low-4-bits mask reads more clearly than
    // bare `15`.
    const aligned = (bump_ptr + 0xF) & ~@as(u32, 0xF);
    bump_ptr = aligned + @as(u32, @intCast(size));
    return @intCast(aligned);
}

fn reset_bump() void {
    bump_ptr = BUMP_START;
}

/// Bump-allocator adapter for `state.init`. Always returns a slice of `size`
/// bytes backed by the per-run bump arena; never null (run() owns the
/// budget — if alloc trips memory bounds the wasm trap surfaces through
/// `panic` like any other shim trap).
fn shimAllocFn(_: ?*anyopaque, size: usize) []u8 {
    const ptr: u32 = @intCast(alloc(@intCast(size)));
    return @as([*]u8, @ptrFromInt(ptr))[0..size];
}

const shim_allocator: state.Allocator = .{ .ctx = null, .alloc = shimAllocFn };

// -- run -------------------------------------------------------------
//
// Scaffold's entry. Sets up the deterministic state from scaffold_env, then
// transfers control to `program._start`. `proc_exit(0)` from the program
// unwinds through this function as a return; `proc_exit(n != 0)` traps via
// `scaffold_env.reject` and never returns.

export fn run() void {
    reset_bump();
    paths.reset();

    // Read scaffold-side scalars before any allocator-bumping work so the
    // bytes we hand to `state.init` are stable. `setup.read` bumps the
    // arena while encoding the verifier and parsing JSON, but only after
    // we've snapshotted the hash + params slice here. The `_in` suffix
    // sidesteps shadowing the `scaffold_env.contract_hash` extern above.
    const contract_hash_in = env.contractHash();
    const params_in = env.params();
    const timestamp_ms_in = env.timestamp();

    const parsed = setup.read(shim_allocator, contract_hash_in) catch |err|
        rejectWith("WASI shim setup failed", err);

    state.init(shim_allocator, .{
        .timestamp_ms = timestamp_ms_in,
        .contract_hash = contract_hash_in,
        .params = params_in,
        .argv = parsed.argv,
        .env = parsed.env,
        .cwd = parsed.cwd,
        .preopens = parsed.preopens,
    });

    setup.populateFdTable(parsed, shim_allocator) catch |err|
        rejectWith("WASI shim fd table init failed", err);

    _start();

    // Auto-close any FDs the program left open. Per the design:
    // "If the program exits with an open FD, the shim closes it
    // automatically before returning to scaffold."
    setup.autoCloseAll();
    // `proc_exit(0)` and a normal return both land here -- nothing else to do.
}

/// Format `<prefix>: <errName>` into a small fixed buffer and reject. Lives
/// here (rather than in scaffold/env.zig) so the buffer is on the run-frame
/// stack -- no static state to confuse re-entry semantics.
fn rejectWith(prefix: []const u8, err: anyerror) noreturn {
    var buf: [96]u8 = undefined;
    const msg = std.fmt.bufPrint(&buf, "{s}: {s}", .{ prefix, @errorName(err) }) catch
        unreachable;
    env.reject(msg);
}

// -- WASI snapshot preview 1 exports ---------------------------------
//
// Each WASI call dispatches to a small handler module. Most calls return
// `ERRNO_NOTSUP` for now; per-call implementations land in follow-up commits.

export fn proc_exit(rval: i32) noreturn {
    proc.proc_exit(rval);
}

export fn proc_raise(sig: i32) i32 {
    // `proc.proc_raise` is `noreturn`; the i32 return type matches the WASI
    // ABI signature but is never actually produced.
    proc.proc_raise(sig);
}

export fn sched_yield() i32 {
    // Deterministic no-op.
    return @intFromEnum(abi.Errno.SUCCESS);
}

export fn clock_time_get(clock_id: i32, precision: i64, out_time: i32) i32 {
    return clock.clock_time_get(clock_id, precision, out_time);
}

export fn clock_res_get(clock_id: i32, out_resolution: i32) i32 {
    return clock.clock_res_get(clock_id, out_resolution);
}

export fn random_get(buf: i32, buf_len: i32) i32 {
    return random_abi.random_get(buf, buf_len);
}

export fn args_get(argv_ptrs: i32, argv_buf: i32) i32 {
    return args_env.args_get(argv_ptrs, argv_buf);
}

export fn args_sizes_get(out_argc: i32, out_buf_size: i32) i32 {
    return args_env.args_sizes_get(out_argc, out_buf_size);
}

export fn environ_get(env_ptrs: i32, env_buf: i32) i32 {
    return args_env.environ_get(env_ptrs, env_buf);
}

export fn environ_sizes_get(out_count: i32, out_buf_size: i32) i32 {
    return args_env.environ_sizes_get(out_count, out_buf_size);
}

// Everything below returns NOTSUP for the v1-batch-1 shim. Stub them out
// here so the program's `wasi_snapshot_preview1.*` wildcard import resolves.
// Implementations land in subsequent batches.

export fn fd_write(fd: i32, iovs_ptr: i32, iovs_len: i32, out_nwritten: i32) i32 {
    return fd_mod.fd_write(fd, iovs_ptr, iovs_len, out_nwritten);
}
export fn fd_read(fd: i32, iovs_ptr: i32, iovs_len: i32, out_nread: i32) i32 {
    return fd_mod.fd_read(fd, iovs_ptr, iovs_len, out_nread);
}
export fn fd_close(fd: i32) i32 {
    return fd_mod.fd_close(fd);
}
export fn fd_seek(fd: i32, offset: i64, whence: i32, out_new_offset: i32) i32 {
    return fd_mod.fd_seek(fd, offset, whence, out_new_offset);
}
export fn fd_tell(fd: i32, out_offset: i32) i32 {
    return fd_mod.fd_tell(fd, out_offset);
}
export fn fd_fdstat_get(fd: i32, out_stat: i32) i32 {
    return fd_mod.fd_fdstat_get(fd, out_stat);
}
export fn fd_fdstat_set_flags(fd: i32, fdflags: i32) i32 {
    return fd_mod.fd_fdstat_set_flags(fd, fdflags);
}
export fn fd_fdstat_set_rights(_: i32, _: i64, _: i64) i32 {
    return unsupported.notsup();
}
export fn fd_filestat_get(fd: i32, out_stat: i32) i32 {
    return fd_mod.fd_filestat_get(fd, out_stat);
}
export fn fd_filestat_set_size(_: i32, _: i64) i32 {
    return unsupported.notsup();
}
export fn fd_filestat_set_times(_: i32, _: i64, _: i64, _: i32) i32 {
    return unsupported.notsup();
}
export fn fd_readdir(fd: i32, buf: i32, buf_len: i32, cookie: i64, out_bytes_used: i32) i32 {
    return fd_mod.fd_readdir(fd, buf, buf_len, cookie, out_bytes_used);
}
export fn fd_renumber(_: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn fd_sync(_: i32) i32 {
    return unsupported.notsup();
}
export fn fd_datasync(_: i32) i32 {
    return unsupported.notsup();
}
export fn fd_advise(_: i32, _: i64, _: i64, _: i32) i32 {
    return unsupported.notsup();
}
export fn fd_allocate(_: i32, _: i64, _: i64) i32 {
    return unsupported.notsup();
}
export fn fd_prestat_get(fd: i32, out_prestat: i32) i32 {
    return fd_mod.fd_prestat_get(fd, out_prestat);
}
export fn fd_prestat_dir_name(fd: i32, buf: i32, buf_len: i32) i32 {
    return fd_mod.fd_prestat_dir_name(fd, buf, buf_len);
}
export fn fd_pread(_: i32, _: i32, _: i32, _: i64, _: i32) i32 {
    return unsupported.notsup();
}
export fn fd_pwrite(_: i32, _: i32, _: i32, _: i64, _: i32) i32 {
    return unsupported.notsup();
}

export fn path_open(
    dirfd: i32,
    dirflags: i32,
    path_ptr: i32,
    path_len: i32,
    oflags: i32,
    rights_base: i64,
    rights_inheriting: i64,
    fdflags: i32,
    out_fd: i32,
) i32 {
    return path_mod.path_open(
        dirfd,
        dirflags,
        path_ptr,
        path_len,
        oflags,
        rights_base,
        rights_inheriting,
        fdflags,
        out_fd,
    );
}
export fn path_filestat_get(dirfd: i32, dirflags: i32, path_ptr: i32, path_len: i32, out_stat: i32) i32 {
    return path_mod.path_filestat_get(dirfd, dirflags, path_ptr, path_len, out_stat);
}
export fn path_filestat_set_times(
    dirfd: i32,
    dirflags: i32,
    path_ptr: i32,
    path_len: i32,
    atim: i64,
    mtim: i64,
    fst_flags: i32,
) i32 {
    return path_mod.path_filestat_set_times(dirfd, dirflags, path_ptr, path_len, atim, mtim, fst_flags);
}
export fn path_create_directory(dirfd: i32, path_ptr: i32, path_len: i32) i32 {
    return path_mod.path_create_directory(dirfd, path_ptr, path_len);
}
export fn path_remove_directory(dirfd: i32, path_ptr: i32, path_len: i32) i32 {
    return path_mod.path_remove_directory(dirfd, path_ptr, path_len);
}
export fn path_unlink_file(dirfd: i32, path_ptr: i32, path_len: i32) i32 {
    return path_mod.path_unlink_file(dirfd, path_ptr, path_len);
}
export fn path_rename(
    old_dirfd: i32,
    old_path_ptr: i32,
    old_path_len: i32,
    new_dirfd: i32,
    new_path_ptr: i32,
    new_path_len: i32,
) i32 {
    return path_mod.path_rename(
        old_dirfd,
        old_path_ptr,
        old_path_len,
        new_dirfd,
        new_path_ptr,
        new_path_len,
    );
}
export fn path_symlink(
    old_path_ptr: i32,
    old_path_len: i32,
    dirfd: i32,
    new_path_ptr: i32,
    new_path_len: i32,
) i32 {
    return path_mod.path_symlink(old_path_ptr, old_path_len, dirfd, new_path_ptr, new_path_len);
}
export fn path_readlink(
    dirfd: i32,
    path_ptr: i32,
    path_len: i32,
    buf_ptr: i32,
    buf_len: i32,
    out_used: i32,
) i32 {
    return path_mod.path_readlink(dirfd, path_ptr, path_len, buf_ptr, buf_len, out_used);
}
export fn path_link(
    old_dirfd: i32,
    old_dirflags: i32,
    old_path_ptr: i32,
    old_path_len: i32,
    new_dirfd: i32,
    new_path_ptr: i32,
    new_path_len: i32,
) i32 {
    return path_mod.path_link(
        old_dirfd,
        old_dirflags,
        old_path_ptr,
        old_path_len,
        new_dirfd,
        new_path_ptr,
        new_path_len,
    );
}

export fn poll_oneoff(_: i32, _: i32, _: i32, _: i32) i32 {
    return unsupported.notsup();
}

export fn sock_recv(_: i32, _: i32, _: i32, _: i32, _: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn sock_send(_: i32, _: i32, _: i32, _: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn sock_shutdown(_: i32, _: i32) i32 {
    return unsupported.notsup();
}

// -- panic handler ---------------------------------------------------
//
// Avoid pulling in Zig's heavy default panic handler. A WASI shim trap
// surfaces to scaffold as a generic trap; we route it through reject() so
// the user sees a readable reason instead of a bare "unreachable".

pub const std_options: std.Options = .{
    .logFn = noLog,
};

fn noLog(
    comptime _: std.log.Level,
    comptime _: @TypeOf(.enum_literal),
    comptime _: []const u8,
    _: anytype,
) void {}

pub fn panic(msg: []const u8, _: ?*std.builtin.StackTrace, _: ?usize) noreturn {
    // Prefix matches `proc.zig`'s "WASI proc_exit:" / "WASI proc_raise:" so
    // production traps surface with an unambiguous source.
    const prefix = "WASI shim panic: ";
    var buf: [256]u8 = undefined;
    const room = buf.len - prefix.len;
    const copied = @min(msg.len, room);
    @memcpy(buf[0..prefix.len], prefix);
    @memcpy(buf[prefix.len..][0..copied], msg[0..copied]);
    const total = prefix.len + copied;

    // `@bitCast` for the pointer keeps the cast bit-preserving so a high
    // arena address survives; the length is small enough to round-trip via
    // ordinary `@intCast`.
    const ptr_u32: u32 = @intCast(@intFromPtr(&buf[0]));
    reject(@bitCast(ptr_u32), @intCast(total));
    unreachable;
}
