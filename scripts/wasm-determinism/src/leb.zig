// LEB128 encode/decode. Returns bytes consumed/written on success.

pub const Error = error{ Overflow, EndOfStream };

pub fn readU32(bytes: []const u8, idx: *usize) Error!u32 {
    var result: u64 = 0;
    var shift: u6 = 0;
    var i: usize = idx.*;
    while (true) {
        if (i >= bytes.len) return Error.EndOfStream;
        const b = bytes[i];
        i += 1;
        result |= @as(u64, b & 0x7f) << shift;
        if ((b & 0x80) == 0) {
            if (result > 0xffff_ffff) return Error.Overflow;
            idx.* = i;
            return @intCast(result);
        }
        shift += 7;
        if (shift >= 35) return Error.Overflow;
    }
}

pub fn readI32(bytes: []const u8, idx: *usize) Error!i32 {
    var result: i64 = 0;
    var shift: u6 = 0;
    var i: usize = idx.*;
    var b: u8 = 0;
    while (true) {
        if (i >= bytes.len) return Error.EndOfStream;
        b = bytes[i];
        i += 1;
        result |= @as(i64, b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) == 0) break;
        if (shift >= 35) return Error.Overflow;
    }
    if (shift < 64 and (b & 0x40) != 0) {
        result |= @as(i64, -1) << shift;
    }
    if (result > 0x7fff_ffff or result < -0x8000_0000) return Error.Overflow;
    idx.* = i;
    return @intCast(result);
}

pub fn readI64(bytes: []const u8, idx: *usize) Error!i64 {
    var result: i128 = 0;
    var shift: u7 = 0;
    var i: usize = idx.*;
    var b: u8 = 0;
    while (true) {
        if (i >= bytes.len) return Error.EndOfStream;
        b = bytes[i];
        i += 1;
        result |= @as(i128, b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) == 0) break;
        if (shift >= 70) return Error.Overflow;
    }
    if (shift < 128 and (b & 0x40) != 0) {
        result |= @as(i128, -1) << shift;
    }
    if (result > 0x7fff_ffff_ffff_ffff or result < -0x8000_0000_0000_0000) return Error.Overflow;
    idx.* = i;
    return @intCast(result);
}

pub fn skipU32(bytes: []const u8, idx: *usize) Error!void {
    _ = try readU32(bytes, idx);
}

pub fn skipI32(bytes: []const u8, idx: *usize) Error!void {
    _ = try readI32(bytes, idx);
}

pub fn skipI64(bytes: []const u8, idx: *usize) Error!void {
    _ = try readI64(bytes, idx);
}

pub fn writeU32(out: []u8, idx: *usize, value: u32) void {
    var v = value;
    var i = idx.*;
    while (true) {
        var byte: u8 = @intCast(v & 0x7f);
        v >>= 7;
        if (v != 0) byte |= 0x80;
        out[i] = byte;
        i += 1;
        if (v == 0) break;
    }
    idx.* = i;
}

pub fn writeI32(out: []u8, idx: *usize, value: i32) void {
    var v: i64 = value;
    var i = idx.*;
    var more = true;
    while (more) {
        var byte: u8 = @intCast(v & 0x7f);
        v >>= 7;
        const sign_bit = (byte & 0x40) != 0;
        if ((v == 0 and !sign_bit) or (v == -1 and sign_bit)) {
            more = false;
        } else {
            byte |= 0x80;
        }
        out[i] = byte;
        i += 1;
    }
    idx.* = i;
}

pub fn u32Length(value: u32) usize {
    var v = value;
    var n: usize = 0;
    while (true) {
        v >>= 7;
        n += 1;
        if (v == 0) break;
    }
    return n;
}

pub fn i32Length(value: i32) usize {
    var v: i64 = value;
    var n: usize = 0;
    var more = true;
    while (more) {
        const byte: u8 = @intCast(v & 0x7f);
        v >>= 7;
        const sign_bit = (byte & 0x40) != 0;
        if ((v == 0 and !sign_bit) or (v == -1 and sign_bit)) {
            more = false;
        }
        n += 1;
    }
    return n;
}
