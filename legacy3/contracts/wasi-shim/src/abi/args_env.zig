// WASI args_get/environ_get and their _sizes_get pairs. Reads from
// state.argv / state.env.

const abi = @import("types.zig");
const state = @import("../state.zig");
const prog_mem = @import("../scaffold/prog_mem.zig");

const NUL: [1]u8 = .{0};
const EQ: [1]u8 = .{'='}; // 0x3D, separator in the env `key=value\0` encoding.

pub fn args_sizes_get(out_argc: i32, out_buf_size: i32) i32 {
    const s = state.current();
    var total: u32 = 0;
    for (s.argv) |arg| {
        total += @as(u32, @intCast(arg.len)) + 1; // +1 for trailing NUL
    }
    prog_mem.writeU32(@intCast(out_argc), @intCast(s.argv.len));
    prog_mem.writeU32(@intCast(out_buf_size), total);
    return @intFromEnum(abi.Errno.SUCCESS);
}

pub fn args_get(argv_ptrs: i32, argv_buf: i32) i32 {
    const s = state.current();
    var cursor: u32 = @intCast(argv_buf);
    const ptrs_base: u32 = @intCast(argv_ptrs);
    for (s.argv, 0..) |arg, i| {
        prog_mem.writeU32(ptrs_base + @as(u32, @intCast(i * 4)), cursor);
        prog_mem.writeSlice(cursor, arg);
        cursor += @intCast(arg.len);
        prog_mem.writeSlice(cursor, &NUL);
        cursor += 1;
    }
    return @intFromEnum(abi.Errno.SUCCESS);
}

pub fn environ_sizes_get(out_count: i32, out_buf_size: i32) i32 {
    const s = state.current();
    var total: u32 = 0;
    for (s.env) |entry| {
        // `key=value\0`: key bytes + '=' + value bytes + NUL.
        total += @as(u32, @intCast(entry.key.len)) + 1 +
            @as(u32, @intCast(entry.val.len)) + 1;
    }
    prog_mem.writeU32(@intCast(out_count), @intCast(s.env.len));
    prog_mem.writeU32(@intCast(out_buf_size), total);
    return @intFromEnum(abi.Errno.SUCCESS);
}

pub fn environ_get(env_ptrs: i32, env_buf: i32) i32 {
    const s = state.current();
    var cursor: u32 = @intCast(env_buf);
    const ptrs_base: u32 = @intCast(env_ptrs);
    for (s.env, 0..) |entry, i| {
        prog_mem.writeU32(ptrs_base + @as(u32, @intCast(i * 4)), cursor);
        // Encode as `key=value\0`. Three writeSlice calls beats staging into
        // a shim-side buffer for the typical short env entry.
        prog_mem.writeSlice(cursor, entry.key);
        cursor += @intCast(entry.key.len);
        prog_mem.writeSlice(cursor, &EQ);
        cursor += 1;
        prog_mem.writeSlice(cursor, entry.val);
        cursor += @intCast(entry.val.len);
        prog_mem.writeSlice(cursor, &NUL);
        cursor += 1;
    }
    return @intFromEnum(abi.Errno.SUCCESS);
}
