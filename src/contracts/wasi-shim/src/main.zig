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
const unsupported = @import("abi/unsupported.zig");
const state = @import("state.zig");
const env = @import("scaffold/env.zig");

// -- scaffold_env imports --------------------------------------------
//
// These match the flat-export surface declared in `WasmHostBridge.ts`.
// `i64` return values are `packPtrLen` results (high 32 = ptr, low 32 = len)
// pointing into THIS module's memory.

pub extern "scaffold_env" fn mode() i32;
pub extern "scaffold_env" fn timestamp() i64;
pub extern "scaffold_env" fn params() i64;
pub extern "scaffold_env" fn contract_hash() i64;
pub extern "scaffold_env" fn contract_metadata(vp: i32, vl: i32) i64;
pub extern "scaffold_env" fn emit_output(op: i32, ol: i32) void;
pub extern "scaffold_env" fn request_body(vp: i32, vl: i32) i64;
pub extern "scaffold_env" fn fetch(vp: i32, vl: i32, kp: i32, kl: i32) i64;
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

var bump_ptr: u32 = 1024 * 1024; // start above any data section

export fn alloc(size: i32) i32 {
    // 16-byte alignment is plenty for everything we stage (verifier bytes,
    // request bodies, output records). Wire-format codecs assume LE u32/u64
    // alignment at worst.
    const aligned = (bump_ptr + 15) & ~@as(u32, 15);
    bump_ptr = aligned + @as(u32, @intCast(size));
    return @intCast(aligned);
}

fn reset_bump() void {
    bump_ptr = 1024 * 1024;
}

// -- run -------------------------------------------------------------
//
// Scaffold's entry. Sets up the deterministic state from scaffold_env, then
// transfers control to `program._start`. `proc_exit(0)` from the program
// unwinds through this function as a return; `proc_exit(n != 0)` traps via
// `scaffold_env.reject` and never returns.

export fn run() void {
    reset_bump();
    // TODO: wasi_setup parse via setup.zig (Phase B Wave 2) — pass parsed
    // argv/env/cwd/preopens here instead of relying on `InitArgs` defaults.
    state.init(.{
        .timestamp_ms = env.timestamp(),
        .contract_hash = env.contractHash(),
        .params = env.params(),
    });
    _start();
    // `proc_exit(0)` and a normal return both land here -- nothing to do.
}

// -- WASI snapshot preview 1 exports ---------------------------------
//
// Each WASI call dispatches to a small handler module. Most calls return
// `ERRNO_NOTSUP` for now; per-call implementations land in follow-up commits.

export fn proc_exit(rval: i32) noreturn {
    proc.proc_exit(rval);
}

export fn proc_raise(sig: i32) i32 {
    return proc.proc_raise(sig);
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

export fn fd_write(_: i32, _: i32, _: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn fd_read(_: i32, _: i32, _: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn fd_close(_: i32) i32 {
    return unsupported.notsup();
}
export fn fd_seek(_: i32, _: i64, _: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn fd_tell(_: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn fd_fdstat_get(_: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn fd_fdstat_set_flags(_: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn fd_fdstat_set_rights(_: i32, _: i64, _: i64) i32 {
    return unsupported.notsup();
}
export fn fd_filestat_get(_: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn fd_filestat_set_size(_: i32, _: i64) i32 {
    return unsupported.notsup();
}
export fn fd_filestat_set_times(_: i32, _: i64, _: i64, _: i32) i32 {
    return unsupported.notsup();
}
export fn fd_readdir(_: i32, _: i32, _: i32, _: i64, _: i32) i32 {
    return unsupported.notsup();
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
export fn fd_prestat_get(_: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn fd_prestat_dir_name(_: i32, _: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn fd_pread(_: i32, _: i32, _: i32, _: i64, _: i32) i32 {
    return unsupported.notsup();
}
export fn fd_pwrite(_: i32, _: i32, _: i32, _: i64, _: i32) i32 {
    return unsupported.notsup();
}

export fn path_open(_: i32, _: i32, _: i32, _: i32, _: i32, _: i64, _: i64, _: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn path_filestat_get(_: i32, _: i32, _: i32, _: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn path_filestat_set_times(_: i32, _: i32, _: i32, _: i32, _: i64, _: i64, _: i32) i32 {
    return unsupported.notsup();
}
export fn path_create_directory(_: i32, _: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn path_remove_directory(_: i32, _: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn path_unlink_file(_: i32, _: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn path_rename(_: i32, _: i32, _: i32, _: i32, _: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn path_symlink(_: i32, _: i32, _: i32, _: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn path_readlink(_: i32, _: i32, _: i32, _: i32, _: i32, _: i32) i32 {
    return unsupported.notsup();
}
export fn path_link(_: i32, _: i32, _: i32, _: i32, _: i32, _: i32, _: i32) i32 {
    return unsupported.notsup();
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
    reject(@intCast(@intFromPtr(msg.ptr)), @intCast(msg.len));
    unreachable;
}
