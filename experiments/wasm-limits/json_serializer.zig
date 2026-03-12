// Minimal JSON serializer for WASM size testing.
// All output is written to a linear-memory buffer.

const buf_size = 4096;
var buf: [buf_size]u8 = undefined;
var pos: usize = 0;

fn emit(s: []const u8) void {
    for (s) |c| {
        if (pos < buf_size) {
            buf[pos] = c;
            pos += 1;
        }
    }
}

fn emitByte(c: u8) void {
    if (pos < buf_size) {
        buf[pos] = c;
        pos += 1;
    }
}

// ---- String ----

fn writeString(s: [*]const u8, len: usize) void {
    emitByte('"');
    for (0..len) |i| {
        const c = s[i];
        switch (c) {
            '"' => emit("\\\""),
            '\\' => emit("\\\\"),
            '\n' => emit("\\n"),
            '\r' => emit("\\r"),
            '\t' => emit("\\t"),
            else => {
                if (c < 0x20) {
                    emit("\\u00");
                    emitHex(c >> 4);
                    emitHex(c & 0xf);
                } else {
                    emitByte(c);
                }
            },
        }
    }
    emitByte('"');
}

fn emitHex(nibble: u8) void {
    emitByte(if (nibble < 10) '0' + nibble else 'a' + nibble - 10);
}

// ---- Number (i32) ----

fn writeI32(val: i32) void {
    var v = val;
    if (v < 0) {
        emitByte('-');
        // Handle MIN_INT
        if (v == -2147483648) {
            emit("2147483648");
            return;
        }
        v = -v;
    }
    var tmp: [10]u8 = undefined;
    var len: usize = 0;
    if (v == 0) {
        emitByte('0');
        return;
    }
    while (v > 0) {
        tmp[len] = @intCast(@as(u32, @intCast(v)) % 10 + '0');
        v = @divTrunc(v, 10);
        len += 1;
    }
    // Reverse
    var i: usize = len;
    while (i > 0) {
        i -= 1;
        emitByte(tmp[i]);
    }
}

// ---- Float (f64) ----

fn writeF64(val: f64) void {
    // Simple approach: integer part + 6 decimal digits
    if (val != val) {
        emit("null"); // NaN -> null per JSON spec
        return;
    }
    if (val < -3.4e+38 or val > 3.4e+38) {
        emit("null"); // Infinity -> null
        return;
    }
    if (val < 0) {
        emitByte('-');
        writeF64Positive(-val);
    } else {
        writeF64Positive(val);
    }
}

fn writeF64Positive(val: f64) void {
    const int_part: u64 = @intFromFloat(val);
    const frac = val - @as(f64, @floatFromInt(int_part));

    // Integer part
    if (int_part == 0) {
        emitByte('0');
    } else {
        var tmp: [20]u8 = undefined;
        var len: usize = 0;
        var v = int_part;
        while (v > 0) {
            tmp[len] = @intCast(v % 10 + '0');
            v /= 10;
            len += 1;
        }
        var i: usize = len;
        while (i > 0) {
            i -= 1;
            emitByte(tmp[i]);
        }
    }

    // Fractional part (6 digits)
    emitByte('.');
    var f = frac;
    for (0..6) |_| {
        f *= 10.0;
        const digit: u8 = @intFromFloat(f);
        emitByte('0' + digit);
        f -= @as(f64, @floatFromInt(digit));
    }
}

// ---- Bool / Null ----

fn writeBool(val: bool) void {
    if (val) emit("true") else emit("false");
}

fn writeNull() void {
    emit("null");
}

// ---- Array helpers ----

fn beginArray() void {
    emitByte('[');
}

fn endArray() void {
    emitByte(']');
}

fn arraySep(first: bool) void {
    if (!first) emitByte(',');
}

// ---- Object helpers ----

fn beginObject() void {
    emitByte('{');
}

fn endObject() void {
    emitByte('}');
}

fn writeKey(key: [*]const u8, key_len: usize, first: bool) void {
    if (!first) emitByte(',');
    writeString(key, key_len);
    emitByte(':');
}

// ==== Exported API ====

export fn get_buf_ptr() [*]u8 {
    return &buf;
}

export fn get_buf_len() usize {
    return pos;
}

export fn reset() void {
    pos = 0;
}

// Export each serializer so LTO can't remove them

export fn json_string(ptr: [*]const u8, len: usize) void {
    writeString(ptr, len);
}

export fn json_i32(val: i32) void {
    writeI32(val);
}

export fn json_f64(val: f64) void {
    writeF64(val);
}

export fn json_bool(val: u32) void {
    writeBool(val != 0);
}

export fn json_null() void {
    writeNull();
}

export fn json_begin_array() void {
    beginArray();
}

export fn json_end_array() void {
    endArray();
}

export fn json_array_sep(first: u32) void {
    arraySep(first != 0);
}

export fn json_begin_object() void {
    beginObject();
}

export fn json_end_object() void {
    endObject();
}

export fn json_key(key: [*]const u8, key_len: usize, first: u32) void {
    writeKey(key, key_len, first != 0);
}

// Convenience: serialize a demo object exercising all paths
// Returns length of JSON in buffer
export fn json_demo() usize {
    pos = 0;

    // {"name":"hello\nworld","age":42,"scores":[1,2,3],"pi":3.141593,"active":true,"deleted":null}
    beginObject();

    writeKey("name", 4, true);
    writeString("hello\nworld", 11);

    writeKey("age", 3, false);
    writeI32(42);

    writeKey("neg", 3, false);
    writeI32(-999);

    writeKey("scores", 6, false);
    beginArray();
    arraySep(true);
    writeI32(1);
    arraySep(false);
    writeI32(2);
    arraySep(false);
    writeI32(3);
    endArray();

    writeKey("pi", 2, false);
    writeF64(3.14159265);

    writeKey("active", 6, false);
    writeBool(true);

    writeKey("deleted", 7, false);
    writeNull();

    endObject();

    return pos;
}
