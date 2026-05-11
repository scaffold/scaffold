// Per-function body rewriter. Walks a function body, identifies sites that
// need transformation (currently: memory.grow/table.grow without an abstain
// guard), and emits a rewritten body with the necessary instructions spliced
// in plus any new scratch locals.

const std = @import("std");
const wasm = @import("wasm.zig");
const leb = @import("leb.zig");
const instr = @import("instr.zig");
const parser = @import("parser.zig");

pub const Error = error{
    Banned,
    Malformed,
    OutOfMemory,
    NeedsAbstain,
} || leb.Error;

pub const Plan = struct {
    // Insertion sites: offset within input body where a guard should be
    // emitted immediately after the byte at that offset. The kind tells
    // us which guard pattern to emit.
    sites: []const Site,
    // True if at least one site adds an i32 scratch local.
    needs_i32_scratch: bool,
};

pub const Site = struct {
    /// Byte offset (relative to the body start byte, i.e. the locals-count
    /// byte) where the guard should be inserted. The guard goes *after* the
    /// triggering instruction.
    after_offset: usize,
    kind: SiteKind,
};

pub const SiteKind = enum {
    grow_guard,
};

/// Analyze a function body (`input[body_start..body_end]`). Returns a Plan
/// describing what needs to be inserted, or null if the body already complies
/// (no transformation needed).
pub fn analyze(
    input: []const u8,
    body_start: usize,
    body_end: usize,
    abstain_func_index: ?u32,
    allocator: std.mem.Allocator,
) Error!?Plan {
    // Skip locals declaration.
    var ix = body_start;
    const local_groups = try leb.readU32(input, &ix);
    var g: u32 = 0;
    while (g < local_groups) : (g += 1) {
        try leb.skipU32(input, &ix);
        if (ix >= body_end) return Error.Malformed;
        ix += 1; // valtype byte
    }
    var sites = std.ArrayList(Site).empty;
    var needs_i32_scratch = false;

    while (ix < body_end) {
        const step = try instr.step(input, &ix);
        switch (step.kind) {
            .memory_grow, .table_grow => {
                // Check if the next instructions are the abstain guard.
                if (!matchGuardPattern(input, ix, body_end, abstain_func_index)) {
                    if (abstain_func_index == null) return Error.NeedsAbstain;
                    try sites.append(allocator, .{ .after_offset = ix - body_start, .kind = .grow_guard });
                    needs_i32_scratch = true;
                }
            },
            else => {},
        }
    }

    if (sites.items.len == 0) return null;
    return Plan{
        .sites = sites.items,
        .needs_i32_scratch = needs_i32_scratch,
    };
}

/// Check whether the bytes at `pos` match the abstain guard pattern:
///   local.tee $X
///   i32.const -1
///   i32.eq
///   if (empty block type)
///     call $abstain
///     unreachable
///   end
///   local.get $X       (same $X as the tee)
fn matchGuardPattern(
    input: []const u8,
    pos: usize,
    end: usize,
    abstain_func_index: ?u32,
) bool {
    var ix = pos;
    var tee_idx: u32 = 0;

    // local.tee
    if (ix >= end or input[ix] != wasm.Op.local_tee) return false;
    ix += 1;
    tee_idx = leb.readU32(input, &ix) catch return false;

    // i32.const -1
    if (ix >= end or input[ix] != wasm.Op.i32_const) return false;
    ix += 1;
    const c = leb.readI32(input, &ix) catch return false;
    if (c != -1) return false;

    // i32.eq
    if (ix >= end or input[ix] != wasm.Op.i32_eq) return false;
    ix += 1;

    // if 0x40 (empty block type)
    if (ix + 1 >= end or input[ix] != wasm.Op.@"if" or input[ix + 1] != wasm.BLOCK_TYPE_EMPTY) return false;
    ix += 2;

    // call $abstain
    if (ix >= end or input[ix] != wasm.Op.call) return false;
    ix += 1;
    const call_idx = leb.readU32(input, &ix) catch return false;
    if (abstain_func_index == null or call_idx != abstain_func_index.?) return false;

    // unreachable
    if (ix >= end or input[ix] != wasm.Op.unreachable_op) return false;
    ix += 1;

    // end
    if (ix >= end or input[ix] != wasm.Op.end) return false;
    ix += 1;

    // local.get with same index as tee
    if (ix >= end or input[ix] != wasm.Op.local_get) return false;
    ix += 1;
    const get_idx = leb.readU32(input, &ix) catch return false;
    return get_idx == tee_idx;
}

pub const RewriteCtx = struct {
    input: []const u8,
    body_start: usize,
    body_end: usize,
    abstain_func_index: u32,
    plan: Plan,
    /// Number of params + existing locals; new scratches go at and after this.
    locals_before_scratch: u32,
    /// Output buffer for the body (excluding the leading size LEB128 prefix --
    /// caller patches that in).
    out: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
};

const LocalGroup = struct { count: u32, vt: u8 };

pub fn emit(ctx: *RewriteCtx) Error!void {
    // Re-emit locals declaration with optionally-added scratch.
    var ix = ctx.body_start;
    const old_group_count = try leb.readU32(ctx.input, &ix);

    var new_groups = std.ArrayList(LocalGroup).empty;
    var k: u32 = 0;
    while (k < old_group_count) : (k += 1) {
        const cnt = try leb.readU32(ctx.input, &ix);
        if (ix >= ctx.body_end) return Error.Malformed;
        const vt = ctx.input[ix];
        ix += 1;
        try new_groups.append(ctx.allocator, .{ .count = cnt, .vt = vt });
    }

    // Compute scratch indices and append new groups as needed.
    var scratch_i32_idx: u32 = 0;
    if (ctx.plan.needs_i32_scratch) {
        // Check if last group is already i32 and merge; otherwise append.
        var merged = false;
        if (new_groups.items.len > 0) {
            const last = &new_groups.items[new_groups.items.len - 1];
            if (last.vt == @intFromEnum(wasm.ValType.i32)) {
                scratch_i32_idx = ctx.locals_before_scratch + sumCounts(new_groups.items);
                last.count += 1;
                merged = true;
            }
        }
        if (!merged) {
            scratch_i32_idx = ctx.locals_before_scratch + sumCounts(new_groups.items);
            try new_groups.append(ctx.allocator, .{ .count = 1, .vt = @intFromEnum(wasm.ValType.i32) });
        }
    }

    // Emit locals declaration.
    try writeU32Append(ctx.out, ctx.allocator, @intCast(new_groups.items.len));
    for (new_groups.items) |group| {
        try writeU32Append(ctx.out, ctx.allocator, group.count);
        try ctx.out.append(ctx.allocator, group.vt);
    }

    // Walk instructions, copying through and inserting at sites.
    const instr_start = ix;
    var cur = instr_start;
    var site_idx: usize = 0;

    while (cur < ctx.body_end) {
        const inst_start = cur;
        _ = try instr.step(ctx.input, &cur);
        // Copy instruction bytes.
        try ctx.out.appendSlice(ctx.allocator, ctx.input[inst_start..cur]);

        // If a site fires here, emit the guard pattern.
        if (site_idx < ctx.plan.sites.len) {
            const site = ctx.plan.sites[site_idx];
            if (cur - ctx.body_start == site.after_offset) {
                switch (site.kind) {
                    .grow_guard => try emitGrowGuard(ctx, scratch_i32_idx),
                }
                site_idx += 1;
            }
        }
    }
}

fn sumCounts(groups: []const LocalGroup) u32 {
    var s: u32 = 0;
    for (groups) |g| s += g.count;
    return s;
}

fn emitGrowGuard(ctx: *RewriteCtx, scratch_i32_idx: u32) Error!void {
    const a = ctx.allocator;
    const out = ctx.out;
    // local.tee $scratch_i32
    try out.append(a, wasm.Op.local_tee);
    try writeU32Append(out, a, scratch_i32_idx);
    // i32.const -1
    try out.append(a, wasm.Op.i32_const);
    try writeI32Append(out, a, -1);
    // i32.eq
    try out.append(a, wasm.Op.i32_eq);
    // if (empty)
    try out.append(a, wasm.Op.@"if");
    try out.append(a, wasm.BLOCK_TYPE_EMPTY);
    // call $abstain
    try out.append(a, wasm.Op.call);
    try writeU32Append(out, a, ctx.abstain_func_index);
    // unreachable
    try out.append(a, wasm.Op.unreachable_op);
    // end
    try out.append(a, wasm.Op.end);
    // local.get $scratch_i32
    try out.append(a, wasm.Op.local_get);
    try writeU32Append(out, a, scratch_i32_idx);
}

fn writeU32Append(out: *std.ArrayList(u8), a: std.mem.Allocator, v: u32) Error!void {
    var buf: [5]u8 = undefined;
    var idx: usize = 0;
    leb.writeU32(&buf, &idx, v);
    try out.appendSlice(a, buf[0..idx]);
}

fn writeI32Append(out: *std.ArrayList(u8), a: std.mem.Allocator, v: i32) Error!void {
    var buf: [5]u8 = undefined;
    var idx: usize = 0;
    leb.writeI32(&buf, &idx, v);
    try out.appendSlice(a, buf[0..idx]);
}

/// Counts params + existing locals up to (not including) the new scratch.
/// Caller passes the param count separately; this function consumes the locals
/// declaration and returns the sum.
pub fn paramsPlusLocals(
    input: []const u8,
    body_start: usize,
    body_end: usize,
    num_params: u32,
) Error!u32 {
    var ix = body_start;
    const groups = try leb.readU32(input, &ix);
    var total: u32 = num_params;
    var g: u32 = 0;
    while (g < groups) : (g += 1) {
        const cnt = try leb.readU32(input, &ix);
        if (ix >= body_end) return Error.Malformed;
        ix += 1; // valtype byte
        total += cnt;
    }
    return total;
}
