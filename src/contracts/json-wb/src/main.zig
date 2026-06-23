// Protocol spec: docs/protocol/wasm-abi.md (scaffold_builder / scaffold_walker)

const std = @import("std");

// json-wb: the generic JSON walker/builder contract module.
//
// build_params/build_data assemble a canonical JSON byte string by querying the
// host builder: request_value_type tells us each value's type, then we dispatch
// (request_string/number/bool, or request_array_length / request_object_keys +
// recurse). The host resolves each request against the value tree it holds
// (see NestedBuilderHost), tracking position via begin/end object/array.
//
// walk_params/walk_data are added separately (they parse JSON and call the
// scaffold_walker.emit_* host imports).

// -- Host imports: scaffold_builder.* --------------------------------
// String/bytes replies come back as a packed (ptr,len) i64 into OUR memory
// (the host allocates via our `alloc` and writes there).

extern "scaffold_builder" fn request_value_type(kp: i32, kl: i32, dp: i32, dl: i32) i32;
extern "scaffold_builder" fn request_string(kp: i32, kl: i32, dp: i32, dl: i32) i64;
extern "scaffold_builder" fn request_number(kp: i32, kl: i32, dp: i32, dl: i32) f64;
extern "scaffold_builder" fn request_bool(kp: i32, kl: i32, dp: i32, dl: i32) i32;
extern "scaffold_builder" fn request_array_length(kp: i32, kl: i32, dp: i32, dl: i32) i32;
extern "scaffold_builder" fn request_object_keys(kp: i32, kl: i32, dp: i32, dl: i32) i64;
extern "scaffold_builder" fn begin_object(kp: i32, kl: i32) void;
extern "scaffold_builder" fn end_object() void;
extern "scaffold_builder" fn begin_array(kp: i32, kl: i32) void;
extern "scaffold_builder" fn end_array() void;

// -- Host imports: scaffold_walker.* ---------------------------------
extern "scaffold_walker" fn emit_string(kp: i32, kl: i32, vp: i32, vl: i32, dp: i32, dl: i32) void;
extern "scaffold_walker" fn emit_number(kp: i32, kl: i32, value: f64, dp: i32, dl: i32) void;
extern "scaffold_walker" fn emit_bool(kp: i32, kl: i32, value: i32, dp: i32, dl: i32) void;
extern "scaffold_walker" fn emit_map_start(kp: i32, kl: i32) i32;
extern "scaffold_walker" fn emit_map_end() void;
extern "scaffold_walker" fn emit_list_start(kp: i32, kl: i32, count: i32) i32;
extern "scaffold_walker" fn emit_list_end() void;

// ValueType enum (matches src/contracts/Contract.ts).
const VT_NULL: i32 = 0;
const VT_BOOL: i32 = 1;
const VT_NUMBER: i32 = 2;
const VT_STRING: i32 = 3;
const VT_ARRAY: i32 = 4;
const VT_OBJECT: i32 = 5;
// A Reader byte value. JSON has no byte literal, so a JSON-sourced Reader never
// yields this; it falls through to the `else` (null) arm in the dispatch below.
const VT_BYTES: i32 = 6;

// -- Bump allocator (host writes request replies here via alloc) -----

// Start the arena above the stack + static data/BSS (the `out` buffer etc.),
// mirroring the wasi-shim's layout, so host-written request replies never
// collide with our globals.
const BUMP_START: u32 = 2 * 1024 * 1024;
var bump_ptr: u32 = BUMP_START;

export fn alloc(size: i32) i32 {
    const aligned = (bump_ptr + 0xF) & ~@as(u32, 0xF);
    bump_ptr = aligned + @as(u32, @intCast(size));
    return @intCast(aligned);
}

fn resetBump() void {
    bump_ptr = BUMP_START;
}

// -- Output buffer ---------------------------------------------------

var out: [128 * 1024]u8 = undefined;
var out_len: usize = 0;

fn outReset() void {
    out_len = 0;
}

fn append(bytes: []const u8) void {
    if (out_len + bytes.len > out.len) trap();
    @memcpy(out[out_len .. out_len + bytes.len], bytes);
    out_len += bytes.len;
}

fn appendByte(b: u8) void {
    if (out_len + 1 > out.len) trap();
    out[out_len] = b;
    out_len += 1;
}

fn trap() noreturn {
    unreachable;
}

// -- Memory helpers --------------------------------------------------

fn memSlice(ptr: i32, len: i32) []const u8 {
    const p: [*]const u8 = @ptrFromInt(@as(usize, @intCast(ptr)));
    return p[0..@intCast(len)];
}

fn ptrOf(s: []const u8) i32 {
    return @intCast(@intFromPtr(s.ptr));
}

fn unpackPtr(packed_val: i64) i32 {
    return @intCast(@as(u64, @bitCast(packed_val)) >> 32);
}

fn unpackLen(packed_val: i64) i32 {
    return @intCast(@as(u64, @bitCast(packed_val)) & 0xFFFF_FFFF);
}

fn packResult(ptr: i32, len: i32) i64 {
    const u: u64 = (@as(u64, @intCast(ptr)) << 32) | @as(u64, @intCast(len));
    return @bitCast(u);
}

// -- JSON output helpers ---------------------------------------------

fn appendJsonString(s: []const u8) void {
    appendByte('"');
    for (s) |c| {
        switch (c) {
            '"' => append("\\\""),
            '\\' => append("\\\\"),
            0x08 => append("\\b"),
            0x0C => append("\\f"),
            '\n' => append("\\n"),
            '\r' => append("\\r"),
            '\t' => append("\\t"),
            else => {
                if (c < 0x20) {
                    var buf: [6]u8 = undefined;
                    const hex = "0123456789abcdef";
                    buf[0] = '\\';
                    buf[1] = 'u';
                    buf[2] = '0';
                    buf[3] = '0';
                    buf[4] = hex[(c >> 4) & 0xF];
                    buf[5] = hex[c & 0xF];
                    append(&buf);
                } else {
                    appendByte(c);
                }
            },
        }
    }
    appendByte('"');
}

fn appendNumber(x: f64) void {
    // Integral values in the safe range print as integers (the common case for
    // params); other finite values use Zig's float formatting. Output need only
    // be deterministic + valid JSON (the consumer JSON.parses it).
    var buf: [64]u8 = undefined;
    if (x == @trunc(x) and @abs(x) < 9.007199254740992e15) {
        const i: i64 = @intFromFloat(x);
        const s = std.fmt.bufPrint(&buf, "{d}", .{i}) catch {
            append("0");
            return;
        };
        append(s);
    } else {
        const s = std.fmt.bufPrint(&buf, "{d}", .{x}) catch {
            append("0");
            return;
        };
        append(s);
    }
}

// Decode the next string from a string-list (u32 count; count x (u32 len; utf8))
// at `data[off..]`, returning the slice and advancing `off`. Caller tracks count.
const StringListCursor = struct {
    data: []const u8,
    off: usize,

    fn count(self: *StringListCursor) u32 {
        const c = readU32(self.data, self.off);
        self.off += 4;
        return c;
    }

    fn next(self: *StringListCursor) []const u8 {
        const len = readU32(self.data, self.off);
        self.off += 4;
        const s = self.data[self.off .. self.off + len];
        self.off += len;
        return s;
    }
};

fn readU32(data: []const u8, off: usize) u32 {
    return @as(u32, data[off]) |
        (@as(u32, data[off + 1]) << 8) |
        (@as(u32, data[off + 2]) << 16) |
        (@as(u32, data[off + 3]) << 24);
}

// -- Builder recursion -----------------------------------------------

fn writeValue(key: []const u8) void {
    const kp = ptrOf(key);
    const kl: i32 = @intCast(key.len);
    const t = request_value_type(kp, kl, 0, 0);
    switch (t) {
        VT_BOOL => {
            if (request_bool(kp, kl, 0, 0) != 0) append("true") else append("false");
        },
        VT_NUMBER => appendNumber(request_number(kp, kl, 0, 0)),
        VT_STRING => {
            const r = request_string(kp, kl, 0, 0);
            appendJsonString(memSlice(unpackPtr(r), unpackLen(r)));
        },
        VT_ARRAY => {
            const n = request_array_length(kp, kl, 0, 0);
            appendByte('[');
            begin_array(kp, kl);
            var i: i32 = 0;
            while (i < n) : (i += 1) {
                if (i > 0) appendByte(',');
                var idx_buf: [16]u8 = undefined;
                const idx = std.fmt.bufPrint(&idx_buf, "{d}", .{i}) catch unreachable;
                writeValue(idx);
            }
            end_array();
            appendByte(']');
        },
        VT_OBJECT => {
            const r = request_object_keys(kp, kl, 0, 0);
            // Copy the reply out of the bump arena before recursing (recursion
            // issues more requests that advance/overwrite the arena).
            const reply = memSlice(unpackPtr(r), unpackLen(r));
            var keys_copy: [8 * 1024]u8 = undefined;
            if (reply.len > keys_copy.len) trap();
            @memcpy(keys_copy[0..reply.len], reply);
            var cursor = StringListCursor{ .data = keys_copy[0..reply.len], .off = 0 };
            const cnt = cursor.count();
            // Collect key slices, then sort for canonical key order.
            var key_offs: [256]usize = undefined;
            var key_lens: [256]usize = undefined;
            if (cnt > key_offs.len) trap();
            var j: u32 = 0;
            while (j < cnt) : (j += 1) {
                const s = cursor.next();
                key_offs[j] = @intFromPtr(s.ptr) - @intFromPtr(&keys_copy[0]);
                key_lens[j] = s.len;
            }
            sortKeys(keys_copy[0..reply.len], key_offs[0..cnt], key_lens[0..cnt]);
            appendByte('{');
            begin_object(kp, kl);
            var m: u32 = 0;
            while (m < cnt) : (m += 1) {
                if (m > 0) appendByte(',');
                const k = keys_copy[key_offs[m] .. key_offs[m] + key_lens[m]];
                appendJsonString(k);
                appendByte(':');
                writeValue(k);
            }
            end_object();
            appendByte('}');
        },
        else => append("null"), // VT_NULL and unknown
    }
}

fn sortKeys(buf: []const u8, offs: []usize, lens: []usize) void {
    // Insertion sort by key bytes (ascending) for canonical object ordering.
    var i: usize = 1;
    while (i < offs.len) : (i += 1) {
        const off_i = offs[i];
        const len_i = lens[i];
        var j: usize = i;
        while (j > 0 and lessThan(
            buf[off_i .. off_i + len_i],
            buf[offs[j - 1] .. offs[j - 1] + lens[j - 1]],
        )) : (j -= 1) {
            offs[j] = offs[j - 1];
            lens[j] = lens[j - 1];
        }
        offs[j] = off_i;
        lens[j] = len_i;
    }
}

fn lessThan(a: []const u8, b: []const u8) bool {
    const n = @min(a.len, b.len);
    var i: usize = 0;
    while (i < n) : (i += 1) {
        if (a[i] != b[i]) return a[i] < b[i];
    }
    return a.len < b.len;
}

fn build() i64 {
    resetBump();
    outReset();
    writeValue("");
    return packResult(@intCast(@intFromPtr(&out[0])), @intCast(out_len));
}

export fn build_params() i64 {
    return build();
}

export fn build_data() i64 {
    return build();
}

// -- Walker: parse JSON bytes and stream emit_* host calls -----------
//
// A small recursive-descent JSON parser. Strings are unescaped into the bump
// arena before being passed to emit_string; numbers are parsed to f64. Object
// members are emitted under their key; array elements under their index ("0",
// "1", ...), matching the builder side and the host's walker->object mapping.

const WalkError = error{Invalid};

const Walker = struct {
    input: []const u8,
    pos: usize,

    fn peek(self: *Walker) WalkError!u8 {
        if (self.pos >= self.input.len) return error.Invalid;
        return self.input[self.pos];
    }

    fn skipWs(self: *Walker) void {
        while (self.pos < self.input.len) : (self.pos += 1) {
            switch (self.input[self.pos]) {
                ' ', '\t', '\n', '\r' => {},
                else => return,
            }
        }
    }

    fn expect(self: *Walker, c: u8) WalkError!void {
        if (self.pos >= self.input.len or self.input[self.pos] != c) return error.Invalid;
        self.pos += 1;
    }

    fn matchLiteral(self: *Walker, lit: []const u8) WalkError!void {
        if (self.pos + lit.len > self.input.len) return error.Invalid;
        var i: usize = 0;
        while (i < lit.len) : (i += 1) {
            if (self.input[self.pos + i] != lit[i]) return error.Invalid;
        }
        self.pos += lit.len;
    }

    // Parse a JSON string, unescaping into the bump arena. Returns the slice.
    fn parseString(self: *Walker) WalkError![]const u8 {
        try self.expect('"');
        const start: i32 = alloc(0); // current arena cursor (no bytes yet)
        var len: usize = 0;
        const base: [*]u8 = @ptrFromInt(@as(usize, @intCast(start)));
        while (true) {
            if (self.pos >= self.input.len) return error.Invalid;
            const c = self.input[self.pos];
            self.pos += 1;
            if (c == '"') break;
            if (c == '\\') {
                if (self.pos >= self.input.len) return error.Invalid;
                const e = self.input[self.pos];
                self.pos += 1;
                const decoded: u8 = switch (e) {
                    '"' => '"',
                    '\\' => '\\',
                    '/' => '/',
                    'b' => 0x08,
                    'f' => 0x0C,
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    'u' => {
                        // Decode a \uXXXX BMP escape to UTF-8.
                        if (self.pos + 4 > self.input.len) return error.Invalid;
                        var cp: u21 = 0;
                        var k: usize = 0;
                        while (k < 4) : (k += 1) {
                            cp = cp * 16 + try hexVal(self.input[self.pos + k]);
                        }
                        self.pos += 4;
                        len += encodeUtf8(base, len, cp);
                        continue;
                    },
                    else => return error.Invalid,
                };
                base[len] = decoded;
                len += 1;
                continue;
            }
            base[len] = c;
            len += 1;
        }
        // Reserve the bytes we wrote so later allocs don't overwrite them.
        _ = alloc(@intCast(len));
        return base[0..len];
    }

    fn walkValue(self: *Walker, key: []const u8) WalkError!void {
        self.skipWs();
        const c = try self.peek();
        switch (c) {
            '{' => try self.walkObject(key),
            '[' => try self.walkArray(key),
            '"' => {
                const s = try self.parseString();
                emit_string(ptrOf(key), @intCast(key.len), ptrOf(s), @intCast(s.len), 0, 0);
            },
            't' => {
                try self.matchLiteral("true");
                emit_bool(ptrOf(key), @intCast(key.len), 1, 0, 0);
            },
            'f' => {
                try self.matchLiteral("false");
                emit_bool(ptrOf(key), @intCast(key.len), 0, 0, 0);
            },
            'n' => {
                try self.matchLiteral("null");
                // No emit_null in the ABI; surface JSON null as the empty string.
                emit_string(ptrOf(key), @intCast(key.len), 0, 0, 0, 0);
            },
            '-', '0'...'9' => {
                const n = try self.parseNumber();
                emit_number(ptrOf(key), @intCast(key.len), n, 0, 0);
            },
            else => return error.Invalid,
        }
    }

    fn walkObject(self: *Walker, key: []const u8) WalkError!void {
        try self.expect('{');
        _ = emit_map_start(ptrOf(key), @intCast(key.len));
        self.skipWs();
        if ((try self.peek()) == '}') {
            self.pos += 1;
            emit_map_end();
            return;
        }
        while (true) {
            self.skipWs();
            const member_key = try self.parseString();
            self.skipWs();
            try self.expect(':');
            try self.walkValue(member_key);
            self.skipWs();
            const sep = try self.peek();
            if (sep == ',') {
                self.pos += 1;
                continue;
            }
            if (sep == '}') {
                self.pos += 1;
                break;
            }
            return error.Invalid;
        }
        emit_map_end();
    }

    fn walkArray(self: *Walker, key: []const u8) WalkError!void {
        try self.expect('[');
        // Two-pass would require rescanning; emit_list_start needs a count, so
        // scan ahead for the element count first.
        const count = try self.scanArrayCount();
        _ = emit_list_start(ptrOf(key), @intCast(key.len), count);
        self.skipWs();
        if ((try self.peek()) == ']') {
            self.pos += 1;
            emit_list_end();
            return;
        }
        var idx: i32 = 0;
        while (true) : (idx += 1) {
            var idx_buf: [16]u8 = undefined;
            const idx_key = fmtInt(&idx_buf, idx);
            try self.walkValue(idx_key);
            self.skipWs();
            const sep = try self.peek();
            if (sep == ',') {
                self.pos += 1;
                continue;
            }
            if (sep == ']') {
                self.pos += 1;
                break;
            }
            return error.Invalid;
        }
        emit_list_end();
    }

    // Count top-level elements of the array starting at self.pos (which points
    // at '['), without consuming. Skips nested structures and strings.
    fn scanArrayCount(self: *Walker) WalkError!i32 {
        var p = self.pos + 1; // past '['
        // skip ws
        while (p < self.input.len and isWs(self.input[p])) : (p += 1) {}
        if (p < self.input.len and self.input[p] == ']') return 0;
        var count: i32 = 1;
        var depth: i32 = 0;
        while (p < self.input.len) : (p += 1) {
            const c = self.input[p];
            if (c == '"') {
                p += 1;
                while (p < self.input.len) : (p += 1) {
                    if (self.input[p] == '\\') {
                        p += 1;
                        continue;
                    }
                    if (self.input[p] == '"') break;
                }
                continue;
            }
            if (c == '[' or c == '{') depth += 1;
            if (c == ']' or c == '}') {
                if (depth == 0) break;
                depth -= 1;
            }
            if (c == ',' and depth == 0) count += 1;
        }
        return count;
    }

    fn parseNumber(self: *Walker) WalkError!f64 {
        const start = self.pos;
        if (self.pos < self.input.len and self.input[self.pos] == '-') self.pos += 1;
        while (self.pos < self.input.len) : (self.pos += 1) {
            switch (self.input[self.pos]) {
                '0'...'9', '.', 'e', 'E', '+', '-' => {},
                else => break,
            }
        }
        const slice = self.input[start..self.pos];
        return std.fmt.parseFloat(f64, slice) catch error.Invalid;
    }
};

fn isWs(c: u8) bool {
    return c == ' ' or c == '\t' or c == '\n' or c == '\r';
}

fn hexVal(c: u8) WalkError!u21 {
    return switch (c) {
        '0'...'9' => @intCast(c - '0'),
        'a'...'f' => @intCast(c - 'a' + 10),
        'A'...'F' => @intCast(c - 'A' + 10),
        else => error.Invalid,
    };
}

fn encodeUtf8(base: [*]u8, off: usize, cp: u21) usize {
    if (cp < 0x80) {
        base[off] = @intCast(cp);
        return 1;
    } else if (cp < 0x800) {
        base[off] = @intCast(0xC0 | (cp >> 6));
        base[off + 1] = @intCast(0x80 | (cp & 0x3F));
        return 2;
    } else {
        base[off] = @intCast(0xE0 | (cp >> 12));
        base[off + 1] = @intCast(0x80 | ((cp >> 6) & 0x3F));
        base[off + 2] = @intCast(0x80 | (cp & 0x3F));
        return 3;
    }
}

fn fmtInt(buf: []u8, v: i32) []const u8 {
    return std.fmt.bufPrint(buf, "{d}", .{v}) catch unreachable;
}

fn walk(params_ptr: i32, params_len: i32) void {
    // Do NOT reset the bump arena here: the host wrote the input JSON into it
    // via `alloc` before calling us, so `bump_ptr` already points just past
    // the input. parseString's scratch allocations must land above the input,
    // not on top of it.
    const input = memSlice(params_ptr, params_len);
    var w = Walker{ .input = input, .pos = 0 };
    // Top-level value is emitted under the empty key, mirroring the builder.
    w.walkValue("") catch {
        // Malformed JSON: emit nothing (the host sees an empty tree).
    };
}

export fn walk_params(params_ptr: i32, params_len: i32) void {
    walk(params_ptr, params_len);
}

export fn walk_data(data_ptr: i32, data_len: i32) void {
    walk(data_ptr, data_len);
}
