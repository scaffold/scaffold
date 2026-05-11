// Per-function body rewriter. Walks a function body, identifies sites that
// need transformation, and emits a rewritten body with the necessary
// instructions spliced in plus any new scratch locals.
//
// Currently handles:
//   - memory.grow / table.grow: append abstain-on-fail guard after the op.
//   - local.set/local.tee on f32/f64 locals: prepend NaN canonicalize.
//   - global.set on f32/f64 globals: prepend NaN canonicalize.
//   - f32.store / f64.store: prepend NaN canonicalize on the value.
//
// Not yet handled: v128 stores (lane-wise), call/return float args,
// br* with float values (requires operand-stack typing).

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
    sites: []const Site,
    needs_i32_scratch: bool,
    needs_f32_scratch: bool,
    needs_f64_scratch: bool,
};

pub const Site = struct {
    /// Byte offset within the body (relative to body_start) where the splice
    /// happens. For Position.before, the splice goes just before this offset.
    /// For Position.after, it goes immediately after.
    offset: usize,
    position: Position,
    kind: SiteKind,
};

pub const Position = enum { before, after };

pub const SiteKind = enum {
    grow_guard,
    canonicalize_f32,
    canonicalize_f64,
};

const CANON_F32_BITS: u32 = 0x7fc00000;
const CANON_F64_BITS: u64 = 0x7ff8000000000000;

/// Information the body analyzer needs about the surrounding module.
pub const ModuleCtx = struct {
    func_type: parser.FuncType,
    global_types: []const parser.GlobalType,
    abstain_func_index: ?u32,
};

const InstrWindow = struct {
    starts: [6]usize = undefined,
    count: u8 = 0,

    fn push(self: *@This(), start: usize) void {
        if (self.count < 6) {
            self.starts[self.count] = start;
            self.count += 1;
            return;
        }
        var i: usize = 0;
        while (i < 5) : (i += 1) self.starts[i] = self.starts[i + 1];
        self.starts[5] = start;
    }

    fn lastSix(self: *const @This()) ?[6]usize {
        if (self.count < 6) return null;
        return self.starts;
    }
};

/// Analyze a function body. Returns a Plan describing what needs to be
/// inserted, or null if no transformation is needed.
pub fn analyze(
    input: []const u8,
    body_start: usize,
    body_end: usize,
    ctx: ModuleCtx,
    allocator: std.mem.Allocator,
) Error!?Plan {
    // Read locals declaration.
    var ix = body_start;
    const local_groups = try leb.readU32(input, &ix);

    // Build the full local-type table: params first, then declared locals.
    var local_types = std.ArrayList(wasm.ValType).empty;
    for (ctx.func_type.params) |p| try local_types.append(allocator, p);

    var g: u32 = 0;
    while (g < local_groups) : (g += 1) {
        const cnt = try leb.readU32(input, &ix);
        if (ix >= body_end) return Error.Malformed;
        const vt = wasm.ValType.fromByte(input[ix]) orelse return Error.Malformed;
        ix += 1;
        var k: u32 = 0;
        while (k < cnt) : (k += 1) try local_types.append(allocator, vt);
    }

    var sites = std.ArrayList(Site).empty;
    var needs_i32_scratch = false;
    var needs_f32_scratch = false;
    var needs_f64_scratch = false;

    var window = InstrWindow{};

    while (ix < body_end) {
        const inst_start = ix;
        const step = try instr.step(input, &ix);

        switch (step.kind) {
            .memory_grow, .table_grow => {
                if (!matchGuardPattern(input, ix, body_end, ctx.abstain_func_index)) {
                    if (ctx.abstain_func_index == null) return Error.NeedsAbstain;
                    try sites.append(allocator, .{
                        .offset = ix - body_start,
                        .position = .after,
                        .kind = .grow_guard,
                    });
                    needs_i32_scratch = true;
                }
            },

            .local_set, .local_tee => {
                const idx = step.imm_u32;
                if (idx >= local_types.items.len) return Error.Malformed;
                const vt = local_types.items[idx];
                // local.tee is also the first instruction of our canonicalize
                // sequence. If we recognize it as canon-start, skip adding a
                // new site for it; the *next* consume will check its window.
                const is_canon_start = step.kind == .local_tee and
                    (vt == .f32 or vt == .f64) and
                    matchCanonForward(input, inst_start, body_end, vt);
                if (!is_canon_start) {
                    try maybeAddCanonSite(input, body_start, inst_start, vt, &window, &sites, allocator, &needs_f32_scratch, &needs_f64_scratch);
                }
            },

            .global_set => {
                const idx = step.imm_u32;
                if (idx >= ctx.global_types.len) return Error.Malformed;
                const vt = ctx.global_types[idx].val_type;
                try maybeAddCanonSite(input, body_start, inst_start, vt, &window, &sites, allocator, &needs_f32_scratch, &needs_f64_scratch);
            },

            .f32_store => {
                try maybeAddCanonSite(input, body_start, inst_start, .f32, &window, &sites, allocator, &needs_f32_scratch, &needs_f64_scratch);
            },

            .f64_store => {
                try maybeAddCanonSite(input, body_start, inst_start, .f64, &window, &sites, allocator, &needs_f32_scratch, &needs_f64_scratch);
            },

            else => {},
        }

        window.push(inst_start);
    }

    if (sites.items.len == 0) return null;
    return Plan{
        .sites = sites.items,
        .needs_i32_scratch = needs_i32_scratch,
        .needs_f32_scratch = needs_f32_scratch,
        .needs_f64_scratch = needs_f64_scratch,
    };
}

fn maybeAddCanonSite(
    input: []const u8,
    body_start: usize,
    inst_start: usize,
    vt: wasm.ValType,
    window: *const InstrWindow,
    sites: *std.ArrayList(Site),
    allocator: std.mem.Allocator,
    needs_f32: *bool,
    needs_f64: *bool,
) Error!void {
    const kind: SiteKind = switch (vt) {
        .f32 => .canonicalize_f32,
        .f64 => .canonicalize_f64,
        else => return,
    };
    if (canonPatternBefore(input, inst_start, window, vt)) return;
    try sites.append(allocator, .{
        .offset = inst_start - body_start,
        .position = .before,
        .kind = kind,
    });
    switch (vt) {
        .f32 => needs_f32.* = true,
        .f64 => needs_f64.* = true,
        else => {},
    }
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

    if (ix >= end or input[ix] != wasm.Op.local_tee) return false;
    ix += 1;
    tee_idx = leb.readU32(input, &ix) catch return false;

    if (ix >= end or input[ix] != wasm.Op.i32_const) return false;
    ix += 1;
    const c = leb.readI32(input, &ix) catch return false;
    if (c != -1) return false;

    if (ix >= end or input[ix] != wasm.Op.i32_eq) return false;
    ix += 1;

    if (ix + 1 >= end or input[ix] != wasm.Op.@"if" or input[ix + 1] != wasm.BLOCK_TYPE_EMPTY) return false;
    ix += 2;

    if (ix >= end or input[ix] != wasm.Op.call) return false;
    ix += 1;
    const call_idx = leb.readU32(input, &ix) catch return false;
    if (abstain_func_index == null or call_idx != abstain_func_index.?) return false;

    if (ix >= end or input[ix] != wasm.Op.unreachable_op) return false;
    ix += 1;

    if (ix >= end or input[ix] != wasm.Op.end) return false;
    ix += 1;

    if (ix >= end or input[ix] != wasm.Op.local_get) return false;
    ix += 1;
    const get_idx = leb.readU32(input, &ix) catch return false;
    return get_idx == tee_idx;
}

/// Check whether the 6 instructions starting at `start` match the NaN
/// canonicalize pattern for the given float type. Used to recognize when a
/// local.tee is the first instruction of an inserted canonicalize sequence.
fn matchCanonForward(input: []const u8, start: usize, end: usize, vt: wasm.ValType) bool {
    var ix = start;

    if (ix >= end or input[ix] != wasm.Op.local_tee) return false;
    ix += 1;
    const tee_idx = leb.readU32(input, &ix) catch return false;

    if (vt == .f32) {
        if (ix + 5 > end or input[ix] != wasm.Op.f32_const) return false;
        ix += 1;
        const bits = std.mem.readInt(u32, input[ix..][0..4], .little);
        if (bits != CANON_F32_BITS) return false;
        ix += 4;
    } else if (vt == .f64) {
        if (ix + 9 > end or input[ix] != wasm.Op.f64_const) return false;
        ix += 1;
        const bits = std.mem.readInt(u64, input[ix..][0..8], .little);
        if (bits != CANON_F64_BITS) return false;
        ix += 8;
    } else return false;

    if (ix >= end or input[ix] != wasm.Op.local_get) return false;
    ix += 1;
    const g1 = leb.readU32(input, &ix) catch return false;
    if (g1 != tee_idx) return false;

    if (ix >= end or input[ix] != wasm.Op.local_get) return false;
    ix += 1;
    const g2 = leb.readU32(input, &ix) catch return false;
    if (g2 != tee_idx) return false;

    const eq_op: u8 = if (vt == .f32) wasm.Op.f32_eq else wasm.Op.f64_eq;
    if (ix >= end or input[ix] != eq_op) return false;
    ix += 1;

    if (ix >= end or input[ix] != wasm.Op.select) return false;
    return true;
}

/// Check whether the 6 instructions immediately preceding `inst_start` match
/// the NaN canonicalize pattern for the given float type. The window argument
/// holds the start offsets of recent instructions.
fn canonPatternBefore(
    input: []const u8,
    inst_start: usize,
    window: *const InstrWindow,
    vt: wasm.ValType,
) bool {
    const last_six = window.lastSix() orelse return false;
    // last_six[0..6] are the previous 6 instructions' start offsets.
    // The sequence we expect (in order):
    //   [0] local.tee $tmp
    //   [1] f32.const NaN_can  (or f64.const NaN_can)
    //   [2] local.get $tmp
    //   [3] local.get $tmp
    //   [4] f32.eq  (or f64.eq)
    //   [5] select

    var ix = last_six[0];

    if (ix >= inst_start or input[ix] != wasm.Op.local_tee) return false;
    ix += 1;
    const tee_idx = leb.readU32(input, &ix) catch return false;
    if (ix != last_six[1]) return false;

    if (vt == .f32) {
        if (ix + 4 >= inst_start or input[ix] != wasm.Op.f32_const) return false;
        ix += 1;
        const bits = std.mem.readInt(u32, input[ix..][0..4], .little);
        if (bits != CANON_F32_BITS) return false;
        ix += 4;
    } else if (vt == .f64) {
        if (ix + 8 >= inst_start or input[ix] != wasm.Op.f64_const) return false;
        ix += 1;
        const bits = std.mem.readInt(u64, input[ix..][0..8], .little);
        if (bits != CANON_F64_BITS) return false;
        ix += 8;
    } else return false;
    if (ix != last_six[2]) return false;

    if (ix >= inst_start or input[ix] != wasm.Op.local_get) return false;
    ix += 1;
    const get1_idx = leb.readU32(input, &ix) catch return false;
    if (get1_idx != tee_idx) return false;
    if (ix != last_six[3]) return false;

    if (ix >= inst_start or input[ix] != wasm.Op.local_get) return false;
    ix += 1;
    const get2_idx = leb.readU32(input, &ix) catch return false;
    if (get2_idx != tee_idx) return false;
    if (ix != last_six[4]) return false;

    const eq_op: u8 = if (vt == .f32) wasm.Op.f32_eq else wasm.Op.f64_eq;
    if (ix >= inst_start or input[ix] != eq_op) return false;
    ix += 1;
    if (ix != last_six[5]) return false;

    if (ix >= inst_start or input[ix] != wasm.Op.select) return false;
    ix += 1;
    return ix == inst_start;
}

const LocalGroup = struct { count: u32, vt: u8 };

pub const RewriteCtx = struct {
    input: []const u8,
    body_start: usize,
    body_end: usize,
    abstain_func_index: u32,
    plan: Plan,
    /// Number of params + existing locals; new scratches go at and after this.
    locals_before_scratch: u32,
    out: *std.ArrayList(u8),
    allocator: std.mem.Allocator,
};

pub fn emit(ctx: *RewriteCtx) Error!void {
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

    // Allocate scratch locals as needed. `locals_before_scratch` already
    // counts params + existing declared locals, so the next scratch's index
    // starts at exactly that value.
    var scratch_i32_idx: u32 = 0;
    var scratch_f32_idx: u32 = 0;
    var scratch_f64_idx: u32 = 0;
    var next_scratch_idx = ctx.locals_before_scratch;

    if (ctx.plan.needs_i32_scratch) {
        scratch_i32_idx = next_scratch_idx;
        next_scratch_idx += 1;
        try appendLocal(&new_groups, ctx.allocator, @intFromEnum(wasm.ValType.i32));
    }
    if (ctx.plan.needs_f32_scratch) {
        scratch_f32_idx = next_scratch_idx;
        next_scratch_idx += 1;
        try appendLocal(&new_groups, ctx.allocator, @intFromEnum(wasm.ValType.f32));
    }
    if (ctx.plan.needs_f64_scratch) {
        scratch_f64_idx = next_scratch_idx;
        next_scratch_idx += 1;
        try appendLocal(&new_groups, ctx.allocator, @intFromEnum(wasm.ValType.f64));
    }

    try writeU32Append(ctx.out, ctx.allocator, @intCast(new_groups.items.len));
    for (new_groups.items) |group| {
        try writeU32Append(ctx.out, ctx.allocator, group.count);
        try ctx.out.append(ctx.allocator, group.vt);
    }

    // Walk instructions, copying through and inserting at sites.
    var cur = ix;
    var site_idx: usize = 0;

    while (cur < ctx.body_end) {
        // Emit any "before" sites that fire at this offset.
        while (site_idx < ctx.plan.sites.len) {
            const site = ctx.plan.sites[site_idx];
            if (site.position == .before and cur - ctx.body_start == site.offset) {
                try emitCanon(ctx, site.kind, scratch_f32_idx, scratch_f64_idx);
                site_idx += 1;
            } else break;
        }

        const inst_start = cur;
        _ = try instr.step(ctx.input, &cur);
        try ctx.out.appendSlice(ctx.allocator, ctx.input[inst_start..cur]);

        // Emit any "after" sites that fire at this offset.
        while (site_idx < ctx.plan.sites.len) {
            const site = ctx.plan.sites[site_idx];
            if (site.position == .after and cur - ctx.body_start == site.offset) {
                switch (site.kind) {
                    .grow_guard => try emitGrowGuard(ctx, scratch_i32_idx),
                    else => return Error.Malformed,
                }
                site_idx += 1;
            } else break;
        }
    }
}

fn appendLocal(groups: *std.ArrayList(LocalGroup), a: std.mem.Allocator, vt: u8) Error!void {
    if (groups.items.len > 0) {
        const last = &groups.items[groups.items.len - 1];
        if (last.vt == vt) {
            last.count += 1;
            return;
        }
    }
    try groups.append(a, .{ .count = 1, .vt = vt });
}

fn sumCounts(groups: []const LocalGroup) u32 {
    var s: u32 = 0;
    for (groups) |g| s += g.count;
    return s;
}

fn emitGrowGuard(ctx: *RewriteCtx, scratch_i32_idx: u32) Error!void {
    const a = ctx.allocator;
    const out = ctx.out;
    try out.append(a, wasm.Op.local_tee);
    try writeU32Append(out, a, scratch_i32_idx);
    try out.append(a, wasm.Op.i32_const);
    try writeI32Append(out, a, -1);
    try out.append(a, wasm.Op.i32_eq);
    try out.append(a, wasm.Op.@"if");
    try out.append(a, wasm.BLOCK_TYPE_EMPTY);
    try out.append(a, wasm.Op.call);
    try writeU32Append(out, a, ctx.abstain_func_index);
    try out.append(a, wasm.Op.unreachable_op);
    try out.append(a, wasm.Op.end);
    try out.append(a, wasm.Op.local_get);
    try writeU32Append(out, a, scratch_i32_idx);
}

fn emitCanon(ctx: *RewriteCtx, kind: SiteKind, f32_idx: u32, f64_idx: u32) Error!void {
    const a = ctx.allocator;
    const out = ctx.out;
    switch (kind) {
        .canonicalize_f32 => {
            try out.append(a, wasm.Op.local_tee);
            try writeU32Append(out, a, f32_idx);
            try out.append(a, wasm.Op.f32_const);
            var buf: [4]u8 = undefined;
            std.mem.writeInt(u32, &buf, CANON_F32_BITS, .little);
            try out.appendSlice(a, &buf);
            try out.append(a, wasm.Op.local_get);
            try writeU32Append(out, a, f32_idx);
            try out.append(a, wasm.Op.local_get);
            try writeU32Append(out, a, f32_idx);
            try out.append(a, wasm.Op.f32_eq);
            try out.append(a, wasm.Op.select);
        },
        .canonicalize_f64 => {
            try out.append(a, wasm.Op.local_tee);
            try writeU32Append(out, a, f64_idx);
            try out.append(a, wasm.Op.f64_const);
            var buf: [8]u8 = undefined;
            std.mem.writeInt(u64, &buf, CANON_F64_BITS, .little);
            try out.appendSlice(a, &buf);
            try out.append(a, wasm.Op.local_get);
            try writeU32Append(out, a, f64_idx);
            try out.append(a, wasm.Op.local_get);
            try writeU32Append(out, a, f64_idx);
            try out.append(a, wasm.Op.f64_eq);
            try out.append(a, wasm.Op.select);
        },
        else => return Error.Malformed,
    }
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
