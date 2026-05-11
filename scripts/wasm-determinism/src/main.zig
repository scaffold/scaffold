// Tool entry point. Exports:
//   - transform(input_len: u32) -> i32 : run the transform pass
//   - input_buffer() -> u32           : offset where host writes input bytes
//   - output_buffer() -> u32          : offset where host reads output bytes
//
// Result codes (matching plan):
//   -1  invalid input (banned content, malformed)
//    0  no changes needed; input is already deterministic
//   >0  length of output written to output_buffer()

const std = @import("std");
const transform_mod = @import("transform.zig");

extern "env" fn log(ptr: [*]const u8, len: usize) void;

// Buffers live in linear memory past Zig's static data. We expose offsets
// computed from `__heap_base` (linker symbol) so the data section stays tiny
// instead of bloating the binary with zero-filled storage.
const MAX_INPUT: u32 = 8 * 1024 * 1024;
const MAX_OUTPUT: u32 = 16 * 1024 * 1024;
const MAX_SCRATCH: u32 = 4 * 1024 * 1024;

extern const __heap_base: u8;

fn heapBase() u32 {
    return @intCast(@intFromPtr(&__heap_base));
}

fn inputOffset() u32 {
    return heapBase();
}

fn outputOffset() u32 {
    return heapBase() + MAX_INPUT;
}

fn scratchOffset() u32 {
    return heapBase() + MAX_INPUT + MAX_OUTPUT;
}

fn inputSlice(len: u32) []u8 {
    const p: [*]u8 = @ptrFromInt(inputOffset());
    return p[0..len];
}

fn outputSlice() []u8 {
    const p: [*]u8 = @ptrFromInt(outputOffset());
    return p[0..MAX_OUTPUT];
}

fn scratchSlice() []u8 {
    const p: [*]u8 = @ptrFromInt(scratchOffset());
    return p[0..MAX_SCRATCH];
}

var scratch_used: u32 = 0;

export fn input_buffer() u32 {
    return inputOffset();
}

export fn output_buffer() u32 {
    return outputOffset();
}

export fn input_capacity() u32 {
    return MAX_INPUT;
}

export fn output_capacity() u32 {
    return MAX_OUTPUT;
}

fn scratchReset() void {
    scratch_used = 0;
}

fn scratchAlloc(n: usize, alignment: u8) ?[]u8 {
    const align_mask: u32 = (@as(u32, 1) << @intCast(alignment)) - 1;
    const aligned: u32 = (scratch_used + align_mask) & ~align_mask;
    const n_u32: u32 = @intCast(n);
    const end = aligned + n_u32;
    if (end > MAX_SCRATCH) return null;
    scratch_used = end;
    return scratchSlice()[aligned..end];
}

const ScratchAllocator = struct {
    fn alloc(_: *anyopaque, n: usize, alignment: std.mem.Alignment, _: usize) ?[*]u8 {
        const log2: u8 = @intFromEnum(alignment);
        const slice = scratchAlloc(n, log2) orelse return null;
        return slice.ptr;
    }
    fn resize(_: *anyopaque, _: []u8, _: std.mem.Alignment, _: usize, _: usize) bool {
        return false;
    }
    fn remap(_: *anyopaque, _: []u8, _: std.mem.Alignment, _: usize, _: usize) ?[*]u8 {
        return null;
    }
    fn free(_: *anyopaque, _: []u8, _: std.mem.Alignment, _: usize) void {}
};

const scratch_vtable = std.mem.Allocator.VTable{
    .alloc = ScratchAllocator.alloc,
    .resize = ScratchAllocator.resize,
    .remap = ScratchAllocator.remap,
    .free = ScratchAllocator.free,
};

fn scratchAllocator() std.mem.Allocator {
    return .{ .ptr = undefined, .vtable = &scratch_vtable };
}

fn logMessage(msg: []const u8) void {
    log(msg.ptr, msg.len);
}

pub const Host = struct {
    pub fn logFn(msg: []const u8) void {
        logMessage(msg);
    }
};

export fn transform(input_len: u32) i32 {
    scratchReset();
    if (input_len == 0 or input_len > MAX_INPUT) return -1;
    const input = inputSlice(input_len);

    const result = transform_mod.run(.{
        .input = input,
        .output = outputSlice(),
        .allocator = scratchAllocator(),
        .logFn = Host.logFn,
    }) catch {
        return -1;
    };

    return switch (result) {
        .unchanged => 0,
        .transformed => |n| @intCast(n),
    };
}
