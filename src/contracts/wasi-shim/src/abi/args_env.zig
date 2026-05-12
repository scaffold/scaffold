// args_get / args_sizes_get / environ_get / environ_sizes_get.
//
// All four pull data from a shim-side `argv` / `env` table populated at
// init time from the `wasi_setup` record on the contract block. v1 doesn't
// wire `wasi_setup` parsing yet -- the tables default to empty -- so these
// calls correctly report 0 entries / 0 bytes until setup lands.
//
// Layout (matches wasi-libc):
//   args_get fills `argv_ptrs[argc]` with offsets into `argv_buf`, then
//   writes each arg followed by a single NUL byte into `argv_buf`. argc
//   and total buf size come from `args_sizes_get`.
//
// `environ_*` is parallel; each entry is "KEY=VALUE\0".

const abi = @import("types.zig");
const prog_mem = @import("../scaffold/prog_mem.zig");

// Configuration tables. v1: empty; populated later from wasi_setup parsing.
pub var argv: []const []const u8 = &.{};
pub var env: []const Pair = &.{};

pub const Pair = struct {
    key: []const u8,
    value: []const u8,
};

// -- sizes -----------------------------------------------------------

pub fn args_sizes_get(out_argc: i32, out_buf_size: i32) i32 {
    prog_mem.store_u32_le(@intCast(out_argc), @intCast(argv.len));
    var total: u32 = 0;
    for (argv) |a| total += @as(u32, @intCast(a.len)) + 1; // NUL
    prog_mem.store_u32_le(@intCast(out_buf_size), total);
    return abi.ok();
}

pub fn environ_sizes_get(out_count: i32, out_buf_size: i32) i32 {
    prog_mem.store_u32_le(@intCast(out_count), @intCast(env.len));
    var total: u32 = 0;
    for (env) |e| total += @as(u32, @intCast(e.key.len)) + 1 + @as(u32, @intCast(e.value.len)) + 1;
    prog_mem.store_u32_le(@intCast(out_buf_size), total);
    return abi.ok();
}

// -- get -------------------------------------------------------------
//
// All output pointers are program-memory offsets; everything goes through
// `prog_mem.store_*`. The pointer table writes a 4-byte LE offset per arg;
// the buffer writes raw bytes plus a single NUL terminator.

pub fn args_get(argv_ptrs: i32, argv_buf: i32) i32 {
    var ptrs_off: u32 = @intCast(argv_ptrs);
    var buf_off: u32 = @intCast(argv_buf);
    const nul: [1]u8 = .{0};
    for (argv) |a| {
        prog_mem.store_u32_le(ptrs_off, buf_off);
        ptrs_off += 4;
        prog_mem.store_bytes(buf_off, a);
        buf_off += @intCast(a.len);
        prog_mem.store_bytes(buf_off, &nul);
        buf_off += 1;
    }
    return abi.ok();
}

pub fn environ_get(env_ptrs: i32, env_buf: i32) i32 {
    var ptrs_off: u32 = @intCast(env_ptrs);
    var buf_off: u32 = @intCast(env_buf);
    const eq: [1]u8 = .{'='};
    const nul: [1]u8 = .{0};
    for (env) |e| {
        prog_mem.store_u32_le(ptrs_off, buf_off);
        ptrs_off += 4;
        prog_mem.store_bytes(buf_off, e.key);
        buf_off += @intCast(e.key.len);
        prog_mem.store_bytes(buf_off, &eq);
        buf_off += 1;
        prog_mem.store_bytes(buf_off, e.value);
        buf_off += @intCast(e.value.len);
        prog_mem.store_bytes(buf_off, &nul);
        buf_off += 1;
    }
    return abi.ok();
}
