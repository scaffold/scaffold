// Single-pass transform/validate. Walks each section, accumulates a list of
// edits, and emits output. Returns 0 if no edits were needed (idempotent
// validation pass), otherwise returns the length of the rewritten module.

const std = @import("std");
const wasm = @import("wasm.zig");
const leb = @import("leb.zig");
const parser = @import("parser.zig");
const instr = @import("instr.zig");
const body_rewriter = @import("body.zig");

pub const Error = error{
    Banned,
    Malformed,
    OutOfMemory,
    NeedsAbstain,
} || leb.Error;

pub const Result = union(enum) {
    unchanged,
    transformed: usize,
};

pub const RunOptions = struct {
    input: []const u8,
    output: []u8,
    allocator: std.mem.Allocator,
    logFn: *const fn (msg: []const u8) void,
};

pub const VERSION_SECTION_NAME = "scaffold-transform-version";
pub const VERSION_PAYLOAD = "20250510";

pub fn run(opts: RunOptions) Error!Result {
    const mod = try parser.parse(opts.input, opts.allocator);

    // Pre-flight: full bytecode walk to detect banned content. If banned,
    // we exit early with -1 (returned by main.zig).
    try validateNoBanned(opts.input, mod, opts.logFn);

    // Decide which transformations are needed.
    var modified = false;
    var needs_memory_import = false;

    if (mod.declared_memory) |ml| {
        // Reject shared memory.
        if (ml.shared) {
            log(opts.logFn, "banned: shared memory in memory section");
            return Error.Banned;
        }
        needs_memory_import = true;
        modified = true;
    }

    // Reject shared imported memory or table.
    for (mod.imports) |imp| {
        switch (imp.kind) {
            .memory => |ml| {
                if (ml.shared) {
                    log(opts.logFn, "banned: shared imported memory");
                    return Error.Banned;
                }
            },
            else => {},
        }
    }

    // Analyze each function body to determine if any need rewriting (e.g.,
    // grow-guard insertion). Cache the plans so emitCodeSection can reuse them.
    const body_plans = try analyzeBodies(opts.input, mod, opts.allocator, opts.logFn);
    var any_body_changes = false;
    for (body_plans) |p| {
        if (p != null) {
            any_body_changes = true;
            break;
        }
    }
    if (any_body_changes) modified = true;

    const has_version = hasVersionSection(opts.input, mod);
    if (!has_version) modified = true;

    if (!modified) return .unchanged;

    // Emit the transformed module.
    var emit = Emitter{ .buf = opts.output, .pos = 0 };
    try emitTransformed(&emit, opts.input, mod, body_plans, .{
        .needs_memory_import = needs_memory_import,
        .strip_existing_version_section = has_version, // replace if mismatched
    }, opts.allocator);
    return .{ .transformed = emit.pos };
}

fn log(logFn: *const fn (msg: []const u8) void, msg: []const u8) void {
    logFn(msg);
}

// ============================================================================
// Banned-content validation: walks every function body and rejects banned ops.
// ============================================================================

fn validateNoBanned(
    input: []const u8,
    mod: parser.Module,
    logFn: *const fn (msg: []const u8) void,
) Error!void {
    // Find the code section (if any).
    var code_section: ?parser.Section = null;
    for (mod.sections) |sec| {
        if (sec.id == .code) code_section = sec;
    }
    if (code_section == null) return;

    const sec = code_section.?;
    var idx = sec.start;
    const func_count = try leb.readU32(input, &idx);
    var f: u32 = 0;
    while (f < func_count) : (f += 1) {
        const body_size = try leb.readU32(input, &idx);
        const body_start = idx;
        const body_end = body_start + body_size;
        if (body_end > sec.end) return Error.Malformed;

        // Skip locals.
        var ix = body_start;
        const local_groups = try leb.readU32(input, &ix);
        var g: u32 = 0;
        while (g < local_groups) : (g += 1) {
            try leb.skipU32(input, &ix); // count
            ix += 1; // valtype byte
        }

        // Walk instructions until we hit the function's final `end`.
        while (ix < body_end) {
            const step = instr.step(input, &ix) catch |err| switch (err) {
                else => return err,
            };
            switch (step.kind) {
                .banned_atomic => {
                    log(logFn, "banned: atomic op");
                    return Error.Banned;
                },
                .banned_relaxed_simd => {
                    log(logFn, "banned: relaxed SIMD op");
                    return Error.Banned;
                },
                .banned_simd => {
                    log(logFn, "banned: SIMD op with float-lane potential");
                    return Error.Banned;
                },
                .banned_gc => {
                    log(logFn, "banned: GC op");
                    return Error.Banned;
                },
                .banned_exception => {
                    log(logFn, "banned: exception-handling op");
                    return Error.Banned;
                },
                .banned_reinterpret => {
                    log(logFn, "banned: reinterpret op (float-int bitcast)");
                    return Error.Banned;
                },
                else => {},
            }
        }
        idx = body_end;
    }
}

// ============================================================================
// Idempotence detection.
// ============================================================================

fn hasVersionSection(input: []const u8, mod: parser.Module) bool {
    for (mod.sections) |sec| {
        if (sec.id != .custom) continue;
        var ix = sec.start;
        const name_len = leb.readU32(input, &ix) catch continue;
        if (ix + name_len > sec.end) continue;
        const name = input[ix .. ix + name_len];
        if (!std.mem.eql(u8, name, VERSION_SECTION_NAME)) continue;
        ix += name_len;
        const payload = input[ix..sec.end];
        if (std.mem.eql(u8, payload, VERSION_PAYLOAD)) return true;
    }
    return false;
}

// ============================================================================
// Output emission.
// ============================================================================

const Emitter = struct {
    buf: []u8,
    pos: usize,

    fn writeByte(self: *Emitter, b: u8) void {
        self.buf[self.pos] = b;
        self.pos += 1;
    }

    fn writeBytes(self: *Emitter, bs: []const u8) void {
        @memcpy(self.buf[self.pos .. self.pos + bs.len], bs);
        self.pos += bs.len;
    }

    fn writeU32(self: *Emitter, value: u32) void {
        leb.writeU32(self.buf, &self.pos, value);
    }

    fn writeI32(self: *Emitter, value: i32) void {
        leb.writeI32(self.buf, &self.pos, value);
    }

    fn reserveSectionSize(self: *Emitter) usize {
        // Reserve 5 bytes for the section size LEB128 (max for u32).
        const slot = self.pos;
        self.pos += 5;
        return slot;
    }

    fn patchSectionSize(self: *Emitter, slot: usize, payload_start: usize) void {
        const payload_size: u32 = @intCast(self.pos - payload_start);
        // Write 5-byte fixed-width LEB128 so we don't have to shift bytes.
        var v = payload_size;
        var i: usize = 0;
        while (i < 4) : (i += 1) {
            self.buf[slot + i] = @as(u8, @intCast(v & 0x7f)) | 0x80;
            v >>= 7;
        }
        self.buf[slot + 4] = @intCast(v & 0x7f);
    }
};

const EmitOpts = struct {
    needs_memory_import: bool,
    strip_existing_version_section: bool,
};

fn emitTransformed(
    emit: *Emitter,
    input: []const u8,
    mod: parser.Module,
    body_plans: []const ?body_rewriter.Plan,
    opts: EmitOpts,
    allocator: std.mem.Allocator,
) Error!void {
    // Magic + version.
    emit.writeBytes(&wasm.MAGIC);
    emit.writeBytes(&wasm.VERSION);

    var import_section_emitted = false;

    for (mod.sections) |sec| {
        switch (sec.id) {
            .memory => {
                if (opts.needs_memory_import) {
                    continue;
                } else {
                    emit.writeBytes(input[sec.full_start..sec.full_end]);
                }
            },
            .import => {
                try emitImportSection(emit, input, sec, mod, opts);
                import_section_emitted = true;
            },
            .code => {
                try emitCodeSection(emit, input, sec, mod, body_plans, allocator);
            },
            .custom => {
                if (isVersionSection(input, sec)) continue;
                emit.writeBytes(input[sec.full_start..sec.full_end]);
            },
            else => {
                if (opts.needs_memory_import and !import_section_emitted and !mod.has_env_memory_import) {
                    if (@intFromEnum(sec.id) > @intFromEnum(wasm.SectionId.import)) {
                        try emitSynthImportSection(emit, mod);
                        import_section_emitted = true;
                    }
                }
                emit.writeBytes(input[sec.full_start..sec.full_end]);
            },
        }
    }

    if (opts.needs_memory_import and !import_section_emitted and !mod.has_env_memory_import) {
        try emitSynthImportSection(emit, mod);
    }

    try emitVersionSection(emit);
}

fn emitCodeSection(
    emit: *Emitter,
    input: []const u8,
    sec: parser.Section,
    mod: parser.Module,
    body_plans: []const ?body_rewriter.Plan,
    allocator: std.mem.Allocator,
) Error!void {
    // Quick path: no plan touched any body, so copy through verbatim.
    var any_plan = false;
    for (body_plans) |p| {
        if (p != null) {
            any_plan = true;
            break;
        }
    }
    if (!any_plan) {
        emit.writeBytes(input[sec.full_start..sec.full_end]);
        return;
    }

    // Section id + reserved 5-byte size slot.
    emit.writeByte(@intFromEnum(wasm.SectionId.code));
    const size_slot = emit.reserveSectionSize();
    const payload_start = emit.pos;

    var ix = sec.start;
    const func_count = try leb.readU32(input, &ix);
    emit.writeU32(func_count);

    // The number of imported functions sits at the front of mod.func_types;
    // local functions start at imported_count. We need to know each function's
    // param count (from its type signature) to compute scratch local indices.
    const imported_func_count = imported_func_count: {
        var n: u32 = 0;
        for (mod.imports) |imp| {
            switch (imp.kind) {
                .func => n += 1,
                else => {},
            }
        }
        break :imported_func_count n;
    };

    var f: u32 = 0;
    while (f < func_count) : (f += 1) {
        const body_size = try leb.readU32(input, &ix);
        const body_start = ix;
        const body_end = body_start + body_size;
        if (body_end > sec.end) return Error.Malformed;

        const plan = body_plans[f];
        if (plan == null) {
            // Pass through unchanged: emit size + body bytes.
            emit.writeU32(body_size);
            emit.writeBytes(input[body_start..body_end]);
        } else {
            // Rewrite this function body.
            const global_func_idx = imported_func_count + f;
            const type_idx = mod.func_types[global_func_idx];
            const ft = mod.types[type_idx];
            const num_params: u32 = @intCast(ft.params.len);
            const params_plus_locals = try body_rewriter.paramsPlusLocals(input, body_start, body_end, num_params);

            var out_body = std.ArrayList(u8).empty;
            var ctx = body_rewriter.RewriteCtx{
                .input = input,
                .body_start = body_start,
                .body_end = body_end,
                .abstain_func_index = mod.abstain_func_index orelse 0,
                .plan = plan.?,
                .locals_before_scratch = params_plus_locals,
                .out = &out_body,
                .allocator = allocator,
            };
            try body_rewriter.emit(&ctx);

            emit.writeU32(@intCast(out_body.items.len));
            emit.writeBytes(out_body.items);
        }

        ix = body_end;
    }

    emit.patchSectionSize(size_slot, payload_start);
}

fn analyzeBodies(
    input: []const u8,
    mod: parser.Module,
    allocator: std.mem.Allocator,
    logFn: *const fn (msg: []const u8) void,
) Error![]?body_rewriter.Plan {
    var code_sec: ?parser.Section = null;
    for (mod.sections) |sec| {
        if (sec.id == .code) code_sec = sec;
    }
    if (code_sec == null) return &.{};

    const sec = code_sec.?;
    var ix = sec.start;
    const func_count = try leb.readU32(input, &ix);
    const plans = try allocator.alloc(?body_rewriter.Plan, func_count);

    var imported_func_count: u32 = 0;
    for (mod.imports) |imp| {
        switch (imp.kind) {
            .func => imported_func_count += 1,
            else => {},
        }
    }

    var f: u32 = 0;
    while (f < func_count) : (f += 1) {
        const body_size = try leb.readU32(input, &ix);
        const body_start = ix;
        const body_end = body_start + body_size;
        if (body_end > sec.end) return Error.Malformed;

        const global_func_idx = imported_func_count + f;
        const type_idx = mod.func_types[global_func_idx];
        const ft = mod.types[type_idx];

        const ctx = body_rewriter.ModuleCtx{
            .func_type = ft,
            .global_types = mod.global_types,
            .abstain_func_index = mod.abstain_func_index,
        };

        plans[f] = body_rewriter.analyze(input, body_start, body_end, ctx, allocator) catch |err| switch (err) {
            error.NeedsAbstain => {
                log(logFn, "banned: memory.grow used without env.abstain import");
                return Error.Banned;
            },
            else => return err,
        };
        ix = body_end;
    }

    return plans;
}

fn isVersionSection(input: []const u8, sec: parser.Section) bool {
    if (sec.id != .custom) return false;
    var ix = sec.start;
    const name_len = leb.readU32(input, &ix) catch return false;
    if (ix + name_len > sec.end) return false;
    const name = input[ix .. ix + name_len];
    return std.mem.eql(u8, name, VERSION_SECTION_NAME);
}

fn emitImportSection(
    emit: *Emitter,
    input: []const u8,
    sec: parser.Section,
    mod: parser.Module,
    opts: EmitOpts,
) Error!void {
    if (!opts.needs_memory_import or mod.has_env_memory_import) {
        // Copy through.
        emit.writeBytes(input[sec.full_start..sec.full_end]);
        return;
    }

    // Emit section header (id + size placeholder).
    emit.writeByte(@intFromEnum(wasm.SectionId.import));
    const size_slot = emit.reserveSectionSize();
    const payload_start = emit.pos;

    // Count = existing count + 1.
    var ix = sec.start;
    const old_count = try leb.readU32(input, &ix);
    emit.writeU32(old_count + 1);

    // Emit our memory import first.
    emitMemoryImport(emit, mod.declared_memory.?);

    // Emit existing imports verbatim.
    emit.writeBytes(input[ix..sec.end]);

    emit.patchSectionSize(size_slot, payload_start);
}

fn emitSynthImportSection(emit: *Emitter, mod: parser.Module) Error!void {
    emit.writeByte(@intFromEnum(wasm.SectionId.import));
    const size_slot = emit.reserveSectionSize();
    const payload_start = emit.pos;

    emit.writeU32(1); // one import
    emitMemoryImport(emit, mod.declared_memory.?);

    emit.patchSectionSize(size_slot, payload_start);
}

fn emitMemoryImport(emit: *Emitter, ml: parser.MemoryLimits) void {
    // Module name "env"
    emit.writeU32(3);
    emit.writeBytes("env");
    // Field name "memory"
    emit.writeU32(6);
    emit.writeBytes("memory");
    // Import kind = memory (2)
    emit.writeByte(2);
    // Limits.
    if (ml.max) |max| {
        emit.writeByte(1); // has-max flag
        emit.writeU32(ml.min);
        emit.writeU32(max);
    } else {
        emit.writeByte(0);
        emit.writeU32(ml.min);
    }
}

fn emitVersionSection(emit: *Emitter) Error!void {
    emit.writeByte(@intFromEnum(wasm.SectionId.custom));
    const size_slot = emit.reserveSectionSize();
    const payload_start = emit.pos;

    emit.writeU32(@intCast(VERSION_SECTION_NAME.len));
    emit.writeBytes(VERSION_SECTION_NAME);
    emit.writeBytes(VERSION_PAYLOAD);

    emit.patchSectionSize(size_slot, payload_start);
}
