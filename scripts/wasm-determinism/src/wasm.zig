// WASM binary format constants. References:
//   https://webassembly.github.io/spec/core/binary/instructions.html

pub const MAGIC = [4]u8{ 0x00, 0x61, 0x73, 0x6d };
pub const VERSION = [4]u8{ 0x01, 0x00, 0x00, 0x00 };

pub const SectionId = enum(u8) {
    custom = 0,
    type = 1,
    import = 2,
    function = 3,
    table = 4,
    memory = 5,
    global = 6,
    @"export" = 7,
    start = 8,
    element = 9,
    code = 10,
    data = 11,
    data_count = 12,

    pub fn fromByte(b: u8) ?SectionId {
        return if (b <= 12) @enumFromInt(b) else null;
    }
};

pub const ValType = enum(u8) {
    i32 = 0x7f,
    i64 = 0x7e,
    f32 = 0x7d,
    f64 = 0x7c,
    v128 = 0x7b,
    funcref = 0x70,
    externref = 0x6f,

    pub fn fromByte(b: u8) ?ValType {
        return switch (b) {
            0x7f => .i32,
            0x7e => .i64,
            0x7d => .f32,
            0x7c => .f64,
            0x7b => .v128,
            0x70 => .funcref,
            0x6f => .externref,
            else => null,
        };
    }

    pub fn isFloat(self: ValType) bool {
        return self == .f32 or self == .f64 or self == .v128;
    }
};

pub const ImportKind = enum(u8) {
    func = 0,
    table = 1,
    memory = 2,
    global = 3,
};

// Single-byte opcodes (MVP + standardized post-MVP).
// We list those we need to *recognize*, not exhaustively.
pub const Op = struct {
    pub const unreachable_op: u8 = 0x00;
    pub const nop: u8 = 0x01;
    pub const block: u8 = 0x02;
    pub const loop: u8 = 0x03;
    pub const @"if": u8 = 0x04;
    pub const @"else": u8 = 0x05;
    pub const try_table: u8 = 0x1f; // exception handling -- BANNED
    pub const end: u8 = 0x0b;
    pub const br: u8 = 0x0c;
    pub const br_if: u8 = 0x0d;
    pub const br_table: u8 = 0x0e;
    pub const @"return": u8 = 0x0f;
    pub const call: u8 = 0x10;
    pub const call_indirect: u8 = 0x11;
    pub const return_call: u8 = 0x12;
    pub const return_call_indirect: u8 = 0x13;
    pub const call_ref: u8 = 0x14;
    pub const return_call_ref: u8 = 0x15;
    pub const throw: u8 = 0x08; // BANNED
    pub const throw_ref: u8 = 0x0a; // BANNED
    pub const try_legacy: u8 = 0x06; // legacy exceptions -- BANNED
    pub const catch_legacy: u8 = 0x07; // BANNED

    pub const drop: u8 = 0x1a;
    pub const select: u8 = 0x1b;
    pub const select_t: u8 = 0x1c;

    pub const local_get: u8 = 0x20;
    pub const local_set: u8 = 0x21;
    pub const local_tee: u8 = 0x22;
    pub const global_get: u8 = 0x23;
    pub const global_set: u8 = 0x24;
    pub const table_get: u8 = 0x25;
    pub const table_set: u8 = 0x26;

    pub const i32_load: u8 = 0x28;
    pub const i64_load: u8 = 0x29;
    pub const f32_load: u8 = 0x2a;
    pub const f64_load: u8 = 0x2b;
    pub const i32_load8_s: u8 = 0x2c;
    pub const i32_load8_u: u8 = 0x2d;
    pub const i32_load16_s: u8 = 0x2e;
    pub const i32_load16_u: u8 = 0x2f;
    pub const i64_load8_s: u8 = 0x30;
    pub const i64_load8_u: u8 = 0x31;
    pub const i64_load16_s: u8 = 0x32;
    pub const i64_load16_u: u8 = 0x33;
    pub const i64_load32_s: u8 = 0x34;
    pub const i64_load32_u: u8 = 0x35;
    pub const i32_store: u8 = 0x36;
    pub const i64_store: u8 = 0x37;
    pub const f32_store: u8 = 0x38;
    pub const f64_store: u8 = 0x39;
    pub const i32_store8: u8 = 0x3a;
    pub const i32_store16: u8 = 0x3b;
    pub const i64_store8: u8 = 0x3c;
    pub const i64_store16: u8 = 0x3d;
    pub const i64_store32: u8 = 0x3e;

    pub const memory_size: u8 = 0x3f;
    pub const memory_grow: u8 = 0x40;

    pub const i32_const: u8 = 0x41;
    pub const i64_const: u8 = 0x42;
    pub const f32_const: u8 = 0x43;
    pub const f64_const: u8 = 0x44;

    pub const i32_eqz: u8 = 0x45;
    pub const i32_eq: u8 = 0x46;
    pub const f32_eq: u8 = 0x5b;
    pub const f64_eq: u8 = 0x61;

    // NaN-producing float arithmetic (used for type tracking).
    pub const f32_add: u8 = 0x92;
    pub const f32_sub: u8 = 0x93;
    pub const f32_mul: u8 = 0x94;
    pub const f32_div: u8 = 0x95;
    pub const f32_min: u8 = 0x96;
    pub const f32_max: u8 = 0x97;
    pub const f32_copysign: u8 = 0x98;
    pub const f32_abs: u8 = 0x8b;
    pub const f32_neg: u8 = 0x8c;
    pub const f32_ceil: u8 = 0x8d;
    pub const f32_floor: u8 = 0x8e;
    pub const f32_trunc: u8 = 0x8f;
    pub const f32_nearest: u8 = 0x90;
    pub const f32_sqrt: u8 = 0x91;

    pub const f64_add: u8 = 0xa0;
    pub const f64_sub: u8 = 0xa1;
    pub const f64_mul: u8 = 0xa2;
    pub const f64_div: u8 = 0xa3;
    pub const f64_min: u8 = 0xa4;
    pub const f64_max: u8 = 0xa5;
    pub const f64_copysign: u8 = 0xa6;
    pub const f64_abs: u8 = 0x99;
    pub const f64_neg: u8 = 0x9a;
    pub const f64_ceil: u8 = 0x9b;
    pub const f64_floor: u8 = 0x9c;
    pub const f64_trunc: u8 = 0x9d;
    pub const f64_nearest: u8 = 0x9e;
    pub const f64_sqrt: u8 = 0x9f;

    // Reinterpret family -- BANNED.
    pub const i32_reinterpret_f32: u8 = 0xbc;
    pub const i64_reinterpret_f64: u8 = 0xbd;
    pub const f32_reinterpret_i32: u8 = 0xbe;
    pub const f64_reinterpret_i64: u8 = 0xbf;

    pub const ref_null: u8 = 0xd0;
    pub const ref_is_null: u8 = 0xd1;
    pub const ref_func: u8 = 0xd2;

    // Multi-byte prefixes.
    pub const fc_prefix: u8 = 0xfc; // bulk memory + numeric conversions
    pub const fd_prefix: u8 = 0xfd; // SIMD (and relaxed SIMD)
    pub const fe_prefix: u8 = 0xfe; // atomics -- ALL BANNED
    pub const fb_prefix: u8 = 0xfb; // GC -- ALL BANNED
};

// Block type encoding markers.
pub const BLOCK_TYPE_EMPTY: u8 = 0x40;
