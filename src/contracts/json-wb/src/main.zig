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

// ValueType enum (matches src/contracts/Contract.ts).
const VT_NULL: i32 = 0;
const VT_BOOL: i32 = 1;
const VT_NUMBER: i32 = 2;
const VT_STRING: i32 = 3;
const VT_ARRAY: i32 = 4;
const VT_OBJECT: i32 = 5;

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
