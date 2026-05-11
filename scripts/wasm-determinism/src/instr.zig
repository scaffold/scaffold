// Instruction walker. Given an offset into bytecode, advance past one full
// instruction (opcode + immediates). Also classifies the instruction for
// the transformer's purposes.

const std = @import("std");
const wasm = @import("wasm.zig");
const leb = @import("leb.zig");

pub const Error = error{ Malformed, Banned } || leb.Error;

pub const Kind = enum {
    other,
    // Banned families.
    banned_atomic,
    banned_relaxed_simd,
    banned_gc,
    banned_exception,
    banned_reinterpret,
    // Escape points (float canonicalization sites).
    local_set, // immediate: local index
    local_tee, // immediate: local index
    global_set, // immediate: global index
    f32_store, // memory-arg (align + offset)
    f64_store,
    v128_store,
    v128_store_lane,
    call, // immediate: func index
    call_indirect, // immediate: type index + table index
    @"return",
    return_call,
    return_call_indirect,
    br, // immediate: label index
    br_if,
    br_table,
    // Control structures (affect block stack).
    block,
    loop,
    @"if",
    @"else",
    end,
    // Resource-grow ops needing abstain guard.
    memory_grow,
    table_grow,
    // NaN-producing arithmetic (kind hint for future canonicalize-after).
    nan_producing,
    @"unreachable",
};

pub const StepResult = struct {
    kind: Kind,
    // Offset of opcode byte.
    opcode_start: usize,
    // Offset of first byte after the instruction's immediates.
    end: usize,
    // For instructions with one u32 immediate, the value (e.g., local index).
    imm_u32: u32 = 0,
    // For call_indirect / return_call_indirect: the type index.
    type_index: u32 = 0,
    // For block/loop/if: the block type byte/encoding.
    block_type: i32 = 0,
};

pub fn step(bytes: []const u8, idx: *usize) Error!StepResult {
    const opcode_start = idx.*;
    if (idx.* >= bytes.len) return Error.Malformed;
    const op = bytes[idx.*];
    idx.* += 1;

    var kind: Kind = .other;
    var imm_u32: u32 = 0;
    var type_index: u32 = 0;
    var block_type: i32 = 0;

    switch (op) {
        wasm.Op.unreachable_op => kind = .@"unreachable",
        wasm.Op.nop, wasm.Op.drop, wasm.Op.select => {},
        wasm.Op.select_t => {
            const n = try leb.readU32(bytes, idx);
            idx.* += n; // one valtype byte per item
        },
        wasm.Op.block => {
            block_type = try readBlockType(bytes, idx);
            kind = .block;
        },
        wasm.Op.loop => {
            block_type = try readBlockType(bytes, idx);
            kind = .loop;
        },
        wasm.Op.@"if" => {
            block_type = try readBlockType(bytes, idx);
            kind = .@"if";
        },
        wasm.Op.@"else" => kind = .@"else",
        wasm.Op.end => kind = .end,
        wasm.Op.br => {
            imm_u32 = try leb.readU32(bytes, idx);
            kind = .br;
        },
        wasm.Op.br_if => {
            imm_u32 = try leb.readU32(bytes, idx);
            kind = .br_if;
        },
        wasm.Op.br_table => {
            const n = try leb.readU32(bytes, idx);
            var i: u32 = 0;
            while (i < n) : (i += 1) try leb.skipU32(bytes, idx);
            try leb.skipU32(bytes, idx); // default label
            kind = .br_table;
        },
        wasm.Op.@"return" => kind = .@"return",
        wasm.Op.call => {
            imm_u32 = try leb.readU32(bytes, idx);
            kind = .call;
        },
        wasm.Op.call_indirect => {
            type_index = try leb.readU32(bytes, idx);
            imm_u32 = try leb.readU32(bytes, idx);
            kind = .call_indirect;
        },
        wasm.Op.return_call => {
            imm_u32 = try leb.readU32(bytes, idx);
            kind = .return_call;
        },
        wasm.Op.return_call_indirect => {
            type_index = try leb.readU32(bytes, idx);
            imm_u32 = try leb.readU32(bytes, idx);
            kind = .return_call_indirect;
        },
        wasm.Op.call_ref => {
            try leb.skipU32(bytes, idx);
        },
        wasm.Op.return_call_ref => {
            try leb.skipU32(bytes, idx);
        },
        wasm.Op.try_table, wasm.Op.try_legacy, wasm.Op.catch_legacy, wasm.Op.throw, wasm.Op.throw_ref => {
            kind = .banned_exception;
        },

        wasm.Op.local_get => {
            try leb.skipU32(bytes, idx);
        },
        wasm.Op.local_set => {
            imm_u32 = try leb.readU32(bytes, idx);
            kind = .local_set;
        },
        wasm.Op.local_tee => {
            imm_u32 = try leb.readU32(bytes, idx);
            kind = .local_tee;
        },
        wasm.Op.global_get => {
            try leb.skipU32(bytes, idx);
        },
        wasm.Op.global_set => {
            imm_u32 = try leb.readU32(bytes, idx);
            kind = .global_set;
        },
        wasm.Op.table_get, wasm.Op.table_set => {
            try leb.skipU32(bytes, idx);
        },

        // memarg loads/stores
        wasm.Op.i32_load,
        wasm.Op.i64_load,
        wasm.Op.f32_load,
        wasm.Op.f64_load,
        wasm.Op.i32_load8_s,
        wasm.Op.i32_load8_u,
        wasm.Op.i32_load16_s,
        wasm.Op.i32_load16_u,
        wasm.Op.i64_load8_s,
        wasm.Op.i64_load8_u,
        wasm.Op.i64_load16_s,
        wasm.Op.i64_load16_u,
        wasm.Op.i64_load32_s,
        wasm.Op.i64_load32_u,
        wasm.Op.i32_store,
        wasm.Op.i64_store,
        wasm.Op.i32_store8,
        wasm.Op.i32_store16,
        wasm.Op.i64_store8,
        wasm.Op.i64_store16,
        wasm.Op.i64_store32,
        => {
            try skipMemArg(bytes, idx);
        },
        wasm.Op.f32_store => {
            try skipMemArg(bytes, idx);
            kind = .f32_store;
        },
        wasm.Op.f64_store => {
            try skipMemArg(bytes, idx);
            kind = .f64_store;
        },

        wasm.Op.memory_size => {
            // reserved zero byte (or memidx in multi-memory).
            try leb.skipU32(bytes, idx);
        },
        wasm.Op.memory_grow => {
            try leb.skipU32(bytes, idx); // memidx
            kind = .memory_grow;
        },

        wasm.Op.i32_const => try leb.skipI32(bytes, idx),
        wasm.Op.i64_const => try leb.skipI64(bytes, idx),
        wasm.Op.f32_const => idx.* += 4,
        wasm.Op.f64_const => idx.* += 8,

        wasm.Op.ref_null => idx.* += 1,
        wasm.Op.ref_is_null => {},
        wasm.Op.ref_func => try leb.skipU32(bytes, idx),

        // Reinterpret family -- BANNED.
        wasm.Op.i32_reinterpret_f32,
        wasm.Op.i64_reinterpret_f64,
        wasm.Op.f32_reinterpret_i32,
        wasm.Op.f64_reinterpret_i64,
        => kind = .banned_reinterpret,

        // NaN-producing float arithmetic.
        wasm.Op.f32_add,
        wasm.Op.f32_sub,
        wasm.Op.f32_mul,
        wasm.Op.f32_div,
        wasm.Op.f32_min,
        wasm.Op.f32_max,
        wasm.Op.f32_ceil,
        wasm.Op.f32_floor,
        wasm.Op.f32_trunc,
        wasm.Op.f32_nearest,
        wasm.Op.f32_sqrt,
        wasm.Op.f64_add,
        wasm.Op.f64_sub,
        wasm.Op.f64_mul,
        wasm.Op.f64_div,
        wasm.Op.f64_min,
        wasm.Op.f64_max,
        wasm.Op.f64_ceil,
        wasm.Op.f64_floor,
        wasm.Op.f64_trunc,
        wasm.Op.f64_nearest,
        wasm.Op.f64_sqrt,
        => kind = .nan_producing,

        // Multi-byte prefixes.
        wasm.Op.fc_prefix => try handleFcPrefix(bytes, idx, &kind),
        wasm.Op.fd_prefix => try handleFdPrefix(bytes, idx, &kind),
        wasm.Op.fe_prefix => {
            // All 0xfe-prefixed ops are atomics -- BANNED.
            kind = .banned_atomic;
            // Skip the sub-op and memarg/immediates without parsing.
            // We only need to consume *some* immediates so caller can move
            // past; since we'll return Banned, this is informational only.
            try leb.skipU32(bytes, idx);
        },
        wasm.Op.fb_prefix => {
            // GC ops -- BANNED.
            kind = .banned_gc;
            try leb.skipU32(bytes, idx);
        },

        else => {
            // All other ops are zero-immediate (comparisons, basic arithmetic, etc.)
        },
    }

    return .{
        .kind = kind,
        .opcode_start = opcode_start,
        .end = idx.*,
        .imm_u32 = imm_u32,
        .type_index = type_index,
        .block_type = block_type,
    };
}

fn skipMemArg(bytes: []const u8, idx: *usize) Error!void {
    const align_byte = try leb.readU32(bytes, idx);
    // Multi-memory: bit 6 of align indicates memidx follows.
    if ((align_byte & 0x40) != 0) {
        try leb.skipU32(bytes, idx);
    }
    try leb.skipU32(bytes, idx); // offset
}

fn readBlockType(bytes: []const u8, idx: *usize) Error!i32 {
    if (idx.* >= bytes.len) return Error.Malformed;
    const b = bytes[idx.*];
    if (b == wasm.BLOCK_TYPE_EMPTY) {
        idx.* += 1;
        return -64; // sentinel: empty block type
    }
    if (wasm.ValType.fromByte(b) != null) {
        idx.* += 1;
        return @as(i32, b);
    }
    return try leb.readI32(bytes, idx);
}

fn handleFcPrefix(bytes: []const u8, idx: *usize, kind: *Kind) Error!void {
    const sub = try leb.readU32(bytes, idx);
    switch (sub) {
        // Saturating truncations -- no immediates.
        0...7 => {},
        // memory.init: data_idx, memidx (0)
        8 => {
            try leb.skipU32(bytes, idx);
            idx.* += 1; // reserved zero
        },
        9 => try leb.skipU32(bytes, idx), // data.drop
        10 => idx.* += 2, // memory.copy: two reserved zeros
        11 => idx.* += 1, // memory.fill: one reserved zero
        // table.init / elem.drop / table.copy / table.grow / table.size / table.fill
        12 => {
            try leb.skipU32(bytes, idx);
            try leb.skipU32(bytes, idx);
        },
        13 => try leb.skipU32(bytes, idx),
        14 => {
            try leb.skipU32(bytes, idx);
            try leb.skipU32(bytes, idx);
        },
        15 => {
            try leb.skipU32(bytes, idx);
            kind.* = .table_grow;
        },
        16 => try leb.skipU32(bytes, idx),
        17 => try leb.skipU32(bytes, idx),
        else => return Error.Malformed,
    }
}

fn handleFdPrefix(bytes: []const u8, idx: *usize, kind: *Kind) Error!void {
    const sub = try leb.readU32(bytes, idx);
    // Relaxed SIMD: sub-opcodes 0x100..=0x113
    if (sub >= 0x100 and sub <= 0x113) {
        kind.* = .banned_relaxed_simd;
    }
    // Sub-opcodes have varied immediates. We list the ones with non-zero
    // immediates; everything else has no extra bytes.
    switch (sub) {
        0 => try skipMemArg(bytes, idx), // v128.load
        1...10 => try skipMemArg(bytes, idx), // v128.load*
        11 => try skipMemArg(bytes, idx), // v128.store
        12 => idx.* += 16, // v128.const
        13 => idx.* += 16, // i8x16.shuffle
        14 => {}, // i8x16.swizzle
        // 21..29: extract/replace lane (1 byte lane idx)
        21...34 => idx.* += 1,
        // load lane (memarg + lane idx)
        84...91 => {
            try skipMemArg(bytes, idx);
            idx.* += 1;
        },
        92, 93 => try skipMemArg(bytes, idx), // v128.load32_zero / 64_zero
        // store_lane
        else => {
            // Most other SIMD ops have no immediate. The "store lane" variants
            // (subops 88-91) are handled above. We may miss some ops with
            // exotic immediates -- they'll fail to parse and be caught.
        },
    }
    // Detect v128 stores so caller can canonicalize before them.
    switch (sub) {
        11 => kind.* = .v128_store,
        88, 89, 90, 91 => kind.* = .v128_store_lane,
        else => {},
    }
}
