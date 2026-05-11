// WASM module parser. Builds the module info needed by the transformer:
//   - Function type signatures (for call/return canonicalization)
//   - Imports (function/memory/global/table)
//   - Function -> type index map
//   - Global types
//
// Does not yet parse instruction bodies -- that happens in transform.zig
// where parsing and emission are interleaved.

const std = @import("std");
const wasm = @import("wasm.zig");
const leb = @import("leb.zig");

pub const Error = error{
    Malformed,
    OutOfMemory,
} || leb.Error;

pub const FuncType = struct {
    params: []const wasm.ValType,
    results: []const wasm.ValType,
};

pub const ImportKindInfo = union(enum) {
    func: u32, // type index
    table: void,
    memory: MemoryLimits,
    global: GlobalType,
};

pub const Import = struct {
    module_name: []const u8,
    field_name: []const u8,
    kind: ImportKindInfo,
};

pub const MemoryLimits = struct {
    min: u32,
    max: ?u32,
    shared: bool,
};

pub const GlobalType = struct {
    val_type: wasm.ValType,
    mutable: bool,
};

pub const Section = struct {
    id: wasm.SectionId,
    // Region within the input that contains the section's payload (after
    // section-id and length bytes are consumed).
    start: usize,
    end: usize,
    // Region that includes the section-id byte through end of payload.
    full_start: usize,
    full_end: usize,
};

pub const Module = struct {
    // Sections in the order they appear in the file.
    sections: []Section,
    types: []FuncType,
    imports: []Import,
    // function index -> type index. Includes imported functions first.
    func_types: []u32,
    // global index -> type. Includes imported globals first.
    global_types: []GlobalType,
    // Memory limits if declared in memory section (not imported).
    declared_memory: ?MemoryLimits,
    // True if memory is imported as ("env", "memory").
    has_env_memory_import: bool,
    // True if abstain function is imported as ("env", "abstain").
    has_env_abstain_import: bool,
    // Function index of env.abstain if imported, otherwise null.
    abstain_func_index: ?u32,
};

pub fn parse(input: []const u8, allocator: std.mem.Allocator) Error!Module {
    if (input.len < 8) return Error.Malformed;
    if (!std.mem.eql(u8, input[0..4], &wasm.MAGIC)) return Error.Malformed;
    if (!std.mem.eql(u8, input[4..8], &wasm.VERSION)) return Error.Malformed;

    var sections = std.ArrayList(Section).empty;
    var idx: usize = 8;

    while (idx < input.len) {
        const section_id_byte = input[idx];
        const full_start = idx;
        idx += 1;
        const size = try leb.readU32(input, &idx);
        const payload_start = idx;
        if (payload_start + size > input.len) return Error.Malformed;
        const payload_end = payload_start + size;
        const section_id = wasm.SectionId.fromByte(section_id_byte) orelse return Error.Malformed;
        try sections.append(allocator, .{
            .id = section_id,
            .start = payload_start,
            .end = payload_end,
            .full_start = full_start,
            .full_end = payload_end,
        });
        idx = payload_end;
    }

    var module = Module{
        .sections = sections.items,
        .types = &.{},
        .imports = &.{},
        .func_types = &.{},
        .global_types = &.{},
        .declared_memory = null,
        .has_env_memory_import = false,
        .has_env_abstain_import = false,
        .abstain_func_index = null,
    };

    for (sections.items) |sec| {
        switch (sec.id) {
            .type => module.types = try parseTypeSection(input[sec.start..sec.end], allocator),
            .import => {
                const result = try parseImportSection(input[sec.start..sec.end], allocator);
                module.imports = result.imports;
                module.func_types = result.imported_func_types;
                module.global_types = result.imported_global_types;
                module.has_env_memory_import = result.has_env_memory;
                module.has_env_abstain_import = result.has_env_abstain;
                module.abstain_func_index = result.abstain_func_index;
            },
            .function => {
                const local_func_types = try parseFunctionSection(input[sec.start..sec.end], allocator);
                // Concatenate imported func types with local ones.
                const total = module.func_types.len + local_func_types.len;
                const combined = try allocator.alloc(u32, total);
                @memcpy(combined[0..module.func_types.len], module.func_types);
                @memcpy(combined[module.func_types.len..], local_func_types);
                module.func_types = combined;
            },
            .memory => {
                const mem_limits = try parseMemorySection(input[sec.start..sec.end]);
                module.declared_memory = mem_limits;
            },
            .global => {
                const local_global_types = try parseGlobalSection(input[sec.start..sec.end], allocator);
                const total = module.global_types.len + local_global_types.len;
                const combined = try allocator.alloc(GlobalType, total);
                @memcpy(combined[0..module.global_types.len], module.global_types);
                @memcpy(combined[module.global_types.len..], local_global_types);
                module.global_types = combined;
            },
            else => {},
        }
    }

    return module;
}

fn parseTypeSection(bytes: []const u8, allocator: std.mem.Allocator) Error![]FuncType {
    var idx: usize = 0;
    const count = try leb.readU32(bytes, &idx);
    const types = try allocator.alloc(FuncType, count);
    var t: usize = 0;
    while (t < count) : (t += 1) {
        if (idx >= bytes.len) return Error.Malformed;
        const form = bytes[idx];
        idx += 1;
        if (form != 0x60) return Error.Malformed; // func type marker
        const param_count = try leb.readU32(bytes, &idx);
        const params = try allocator.alloc(wasm.ValType, param_count);
        var i: usize = 0;
        while (i < param_count) : (i += 1) {
            if (idx >= bytes.len) return Error.Malformed;
            params[i] = wasm.ValType.fromByte(bytes[idx]) orelse return Error.Malformed;
            idx += 1;
        }
        const result_count = try leb.readU32(bytes, &idx);
        const results = try allocator.alloc(wasm.ValType, result_count);
        i = 0;
        while (i < result_count) : (i += 1) {
            if (idx >= bytes.len) return Error.Malformed;
            results[i] = wasm.ValType.fromByte(bytes[idx]) orelse return Error.Malformed;
            idx += 1;
        }
        types[t] = .{ .params = params, .results = results };
    }
    return types;
}

const ImportParseResult = struct {
    imports: []Import,
    imported_func_types: []u32,
    imported_global_types: []GlobalType,
    has_env_memory: bool,
    has_env_abstain: bool,
    abstain_func_index: ?u32,
};

fn parseImportSection(bytes: []const u8, allocator: std.mem.Allocator) Error!ImportParseResult {
    var idx: usize = 0;
    const count = try leb.readU32(bytes, &idx);
    const imports = try allocator.alloc(Import, count);
    var func_types = std.ArrayList(u32).empty;
    var global_types = std.ArrayList(GlobalType).empty;
    var has_env_memory = false;
    var has_env_abstain = false;
    var abstain_func_index: ?u32 = null;
    var i: usize = 0;
    var func_index: u32 = 0;
    while (i < count) : (i += 1) {
        const mod_name = try readString(bytes, &idx);
        const field_name = try readString(bytes, &idx);
        if (idx >= bytes.len) return Error.Malformed;
        const kind_byte = bytes[idx];
        idx += 1;
        const kind: ImportKindInfo = switch (kind_byte) {
            0 => blk: {
                const ti = try leb.readU32(bytes, &idx);
                try func_types.append(allocator, ti);
                const this_func_index = func_index;
                func_index += 1;
                if (std.mem.eql(u8, mod_name, "env") and std.mem.eql(u8, field_name, "abstain")) {
                    has_env_abstain = true;
                    abstain_func_index = this_func_index;
                }
                break :blk .{ .func = ti };
            },
            1 => blk: {
                _ = try readRefType(bytes, &idx);
                _ = try readLimits(bytes, &idx);
                break :blk .{ .table = {} };
            },
            2 => blk: {
                const ml = try readMemoryLimits(bytes, &idx);
                if (std.mem.eql(u8, mod_name, "env") and std.mem.eql(u8, field_name, "memory")) {
                    has_env_memory = true;
                }
                break :blk .{ .memory = ml };
            },
            3 => blk: {
                if (idx >= bytes.len) return Error.Malformed;
                const val_type = wasm.ValType.fromByte(bytes[idx]) orelse return Error.Malformed;
                idx += 1;
                if (idx >= bytes.len) return Error.Malformed;
                const mutable = bytes[idx] != 0;
                idx += 1;
                try global_types.append(allocator, .{ .val_type = val_type, .mutable = mutable });
                break :blk .{ .global = .{ .val_type = val_type, .mutable = mutable } };
            },
            else => return Error.Malformed,
        };
        imports[i] = .{ .module_name = mod_name, .field_name = field_name, .kind = kind };
    }
    return .{
        .imports = imports,
        .imported_func_types = func_types.items,
        .imported_global_types = global_types.items,
        .has_env_memory = has_env_memory,
        .has_env_abstain = has_env_abstain,
        .abstain_func_index = abstain_func_index,
    };
}

fn parseFunctionSection(bytes: []const u8, allocator: std.mem.Allocator) Error![]u32 {
    var idx: usize = 0;
    const count = try leb.readU32(bytes, &idx);
    const out = try allocator.alloc(u32, count);
    var i: usize = 0;
    while (i < count) : (i += 1) {
        out[i] = try leb.readU32(bytes, &idx);
    }
    return out;
}

fn parseMemorySection(bytes: []const u8) Error!MemoryLimits {
    var idx: usize = 0;
    const count = try leb.readU32(bytes, &idx);
    if (count == 0) return MemoryLimits{ .min = 0, .max = null, .shared = false };
    return try readMemoryLimits(bytes, &idx);
}

fn parseGlobalSection(bytes: []const u8, allocator: std.mem.Allocator) Error![]GlobalType {
    var idx: usize = 0;
    const count = try leb.readU32(bytes, &idx);
    const out = try allocator.alloc(GlobalType, count);
    var i: usize = 0;
    while (i < count) : (i += 1) {
        if (idx >= bytes.len) return Error.Malformed;
        const val_type = wasm.ValType.fromByte(bytes[idx]) orelse return Error.Malformed;
        idx += 1;
        if (idx >= bytes.len) return Error.Malformed;
        const mutable = bytes[idx] != 0;
        idx += 1;
        out[i] = .{ .val_type = val_type, .mutable = mutable };
        // Skip init expression (sequence of instructions ending with 0x0B).
        try skipInitExpr(bytes, &idx);
    }
    return out;
}

fn skipInitExpr(bytes: []const u8, idx: *usize) Error!void {
    // Init exprs are constant instruction sequences ending with `end` (0x0b).
    // We need to handle nested blocks just in case, though const exprs don't
    // typically contain block/loop/if. Fast and conservative: scan for 0x0b.
    var depth: u32 = 0;
    while (idx.* < bytes.len) {
        const op = bytes[idx.*];
        idx.* += 1;
        switch (op) {
            wasm.Op.end => {
                if (depth == 0) return;
                depth -= 1;
            },
            wasm.Op.block, wasm.Op.loop, wasm.Op.@"if" => {
                try skipBlockType(bytes, idx);
                depth += 1;
            },
            wasm.Op.i32_const => try leb.skipI32(bytes, idx),
            wasm.Op.i64_const => try leb.skipI64(bytes, idx),
            wasm.Op.f32_const => idx.* += 4,
            wasm.Op.f64_const => idx.* += 8,
            wasm.Op.global_get, wasm.Op.ref_func => try leb.skipU32(bytes, idx),
            wasm.Op.ref_null => idx.* += 1,
            else => {},
        }
    }
    return Error.Malformed;
}

fn skipBlockType(bytes: []const u8, idx: *usize) Error!void {
    if (idx.* >= bytes.len) return Error.Malformed;
    const b = bytes[idx.*];
    // Empty block type or single valtype: one byte.
    if (b == wasm.BLOCK_TYPE_EMPTY or wasm.ValType.fromByte(b) != null) {
        idx.* += 1;
        return;
    }
    // Otherwise signed LEB128 type index.
    _ = try leb.readI32(bytes, idx);
}

fn readString(bytes: []const u8, idx: *usize) Error![]const u8 {
    const len = try leb.readU32(bytes, idx);
    if (idx.* + len > bytes.len) return Error.Malformed;
    const s = bytes[idx.* .. idx.* + len];
    idx.* += len;
    return s;
}

fn readRefType(bytes: []const u8, idx: *usize) Error!u8 {
    if (idx.* >= bytes.len) return Error.Malformed;
    const b = bytes[idx.*];
    idx.* += 1;
    return b;
}

fn readLimits(bytes: []const u8, idx: *usize) Error!struct { min: u32, max: ?u32 } {
    if (idx.* >= bytes.len) return Error.Malformed;
    const flag = bytes[idx.*];
    idx.* += 1;
    const min = try leb.readU32(bytes, idx);
    var max: ?u32 = null;
    if ((flag & 1) != 0) {
        max = try leb.readU32(bytes, idx);
    }
    return .{ .min = min, .max = max };
}

fn readMemoryLimits(bytes: []const u8, idx: *usize) Error!MemoryLimits {
    if (idx.* >= bytes.len) return Error.Malformed;
    const flag = bytes[idx.*];
    idx.* += 1;
    const has_max = (flag & 1) != 0;
    const shared = (flag & 2) != 0;
    const min = try leb.readU32(bytes, idx);
    var max: ?u32 = null;
    if (has_max) {
        max = try leb.readU32(bytes, idx);
    }
    return .{ .min = min, .max = max, .shared = shared };
}
