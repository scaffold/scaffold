// JSON subset for wasi_setup; numbers and surrogate pairs not supported.
//
// Covers exactly what `wasi_setup` (see docs/design/wasi-shim.md) needs:
// objects, arrays, strings (with `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`,
// `\t`, and `\uXXXX` BMP escapes), `null`, `true`, `false`, and JSON
// whitespace. Numbers and UTF-16 surrogate pairs are explicitly rejected;
// `wasi_setup` is hand-typed paths and string maps, so we don't need them.
//
// Memory: every Value-internal slice (decoded strings, []Value arrays, and
// []ObjectEntry maps) is allocated through the caller-supplied bump
// `Allocator`. The input slice is NOT borrowed afterward — strings are
// always copied (and decoded) into fresh memory so the caller can drop or
// reuse the input buffer once `parse` returns.

const std = @import("std");

pub const ValueTag = enum { null_, bool_, string_, array_, object_ };

pub const Value = union(ValueTag) {
    null_: void,
    bool_: bool,
    string_: []const u8,
    array_: []Value,
    object_: []ObjectEntry,
};

pub const ObjectEntry = struct {
    key: []const u8,
    value: Value,
};

pub const ParseError = error{
    Invalid,
    Unexpected,
    UnterminatedString,
    BadEscape,
    UnsupportedNumber,
    OutOfArenaMemory,
};

/// Bare allocator interface — the shim wires this to its bump arena in
/// main.zig. We deliberately don't take `std.mem.Allocator`: that pulls in
/// extra `std.mem` machinery we don't want in a freestanding wasm shim.
pub const Allocator = struct {
    ctx: ?*anyopaque,
    alloc: *const fn (ctx: ?*anyopaque, size: usize) ParseError![]u8,
};

const max_depth: u8 = 32;

const Parser = struct {
    input: []const u8,
    pos: usize,
    alloc: Allocator,
    depth: u8,

    fn peek(self: *Parser) ParseError!u8 {
        if (self.pos >= self.input.len) return error.Unexpected;
        return self.input[self.pos];
    }

    fn advance(self: *Parser) void {
        self.pos += 1;
    }

    fn skipWs(self: *Parser) void {
        while (self.pos < self.input.len) {
            switch (self.input[self.pos]) {
                ' ', '\t', '\n', '\r' => self.pos += 1,
                else => return,
            }
        }
    }

    fn expect(self: *Parser, c: u8) ParseError!void {
        if (self.pos >= self.input.len or self.input[self.pos] != c) {
            return error.Invalid;
        }
        self.pos += 1;
    }

    fn matchLiteral(self: *Parser, lit: []const u8) ParseError!void {
        if (self.pos + lit.len > self.input.len) return error.Invalid;
        if (!std.mem.eql(u8, self.input[self.pos .. self.pos + lit.len], lit)) {
            return error.Invalid;
        }
        self.pos += lit.len;
    }

    fn enter(self: *Parser) ParseError!void {
        if (self.depth >= max_depth) return error.Invalid;
        self.depth += 1;
    }

    fn leave(self: *Parser) void {
        self.depth -= 1;
    }

    fn parseValue(self: *Parser) ParseError!Value {
        self.skipWs();
        const c = try self.peek();
        return switch (c) {
            '{' => try self.parseObject(),
            '[' => try self.parseArray(),
            '"' => Value{ .string_ = try self.parseString() },
            't' => blk: {
                try self.matchLiteral("true");
                break :blk Value{ .bool_ = true };
            },
            'f' => blk: {
                try self.matchLiteral("false");
                break :blk Value{ .bool_ = false };
            },
            'n' => blk: {
                try self.matchLiteral("null");
                break :blk Value{ .null_ = {} };
            },
            // Numbers are out of scope for wasi_setup. Reject explicitly so
            // a malformed (or schema-drifted) input surfaces as a clear
            // error rather than getting mistaken for invalid syntax.
            '-', '0'...'9' => error.UnsupportedNumber,
            else => error.Invalid,
        };
    }

    fn parseObject(self: *Parser) ParseError!Value {
        try self.enter();
        defer self.leave();

        try self.expect('{');
        self.skipWs();

        // Two-pass: first count entries so we allocate once. The bump
        // allocator can't shrink, and we'd rather not over-reserve.
        const start = self.pos;
        const count = try self.scanObjectCount();
        self.pos = start;

        if (count == 0) {
            try self.expect('}');
            return Value{ .object_ = &[_]ObjectEntry{} };
        }

        const bytes = try self.alloc.alloc(self.alloc.ctx, count * @sizeOf(ObjectEntry));
        const entries: []ObjectEntry = @as([*]ObjectEntry, @ptrCast(@alignCast(bytes.ptr)))[0..count];

        var i: usize = 0;
        while (i < count) : (i += 1) {
            self.skipWs();
            const key = try self.parseString();
            self.skipWs();
            try self.expect(':');
            const value = try self.parseValue();
            entries[i] = .{ .key = key, .value = value };
            self.skipWs();
            if (i + 1 < count) {
                try self.expect(',');
            } else {
                try self.expect('}');
            }
        }
        return Value{ .object_ = entries };
    }

    fn parseArray(self: *Parser) ParseError!Value {
        try self.enter();
        defer self.leave();

        try self.expect('[');
        self.skipWs();

        const start = self.pos;
        const count = try self.scanArrayCount();
        self.pos = start;

        if (count == 0) {
            try self.expect(']');
            return Value{ .array_ = &[_]Value{} };
        }

        const bytes = try self.alloc.alloc(self.alloc.ctx, count * @sizeOf(Value));
        const items: []Value = @as([*]Value, @ptrCast(@alignCast(bytes.ptr)))[0..count];

        var i: usize = 0;
        while (i < count) : (i += 1) {
            const value = try self.parseValue();
            items[i] = value;
            self.skipWs();
            if (i + 1 < count) {
                try self.expect(',');
            } else {
                try self.expect(']');
            }
        }
        return Value{ .array_ = items };
    }

    /// Count entries in the object that starts at the current `pos` (just
    /// past the `{`). Returns 0 for `}` immediately. Advances `pos` to one
    /// past the closing `}`. The structural pass does NOT decode strings or
    /// recursively materialise nested values — it just balances brackets so
    /// we know how big the entries slice should be.
    fn scanObjectCount(self: *Parser) ParseError!usize {
        self.skipWs();
        if ((try self.peek()) == '}') {
            self.advance();
            return 0;
        }
        var n: usize = 0;
        while (true) {
            self.skipWs();
            try self.skipString();
            self.skipWs();
            try self.expect(':');
            try self.skipValue();
            n += 1;
            self.skipWs();
            const c = try self.peek();
            self.advance();
            if (c == ',') continue;
            if (c == '}') return n;
            return error.Invalid;
        }
    }

    fn scanArrayCount(self: *Parser) ParseError!usize {
        self.skipWs();
        if ((try self.peek()) == ']') {
            self.advance();
            return 0;
        }
        var n: usize = 0;
        while (true) {
            try self.skipValue();
            n += 1;
            self.skipWs();
            const c = try self.peek();
            self.advance();
            if (c == ',') continue;
            if (c == ']') return n;
            return error.Invalid;
        }
    }

    /// Skip-only counterpart to `parseValue`. Does not decode or allocate;
    /// just walks structure so we can count siblings before the real
    /// allocate-and-fill pass. Tracks depth so a deeply nested junk input
    /// can't blow the stack via this path either. Containers delegate to
    /// the same `scan*Count` helpers the real pass uses, so there's only
    /// one place that knows JSON object/array shape.
    fn skipValue(self: *Parser) ParseError!void {
        try self.enter();
        defer self.leave();

        self.skipWs();
        const c = try self.peek();
        switch (c) {
            '{' => {
                self.advance();
                _ = try self.scanObjectCount();
            },
            '[' => {
                self.advance();
                _ = try self.scanArrayCount();
            },
            '"' => try self.skipString(),
            't' => try self.matchLiteral("true"),
            'f' => try self.matchLiteral("false"),
            'n' => try self.matchLiteral("null"),
            '-', '0'...'9' => return error.UnsupportedNumber,
            else => return error.Invalid,
        }
    }

    /// Walk a JSON string in-place without decoding. Validates escape
    /// sequences enough to keep the pos advance honest (so we know where
    /// the closing quote is) but doesn't allocate a decoded copy.
    fn skipString(self: *Parser) ParseError!void {
        try self.expect('"');
        while (self.pos < self.input.len) {
            const c = self.input[self.pos];
            self.pos += 1;
            switch (c) {
                '"' => return,
                '\\' => {
                    if (self.pos >= self.input.len) return error.UnterminatedString;
                    const esc = self.input[self.pos];
                    self.pos += 1;
                    switch (esc) {
                        '"', '\\', '/', 'b', 'f', 'n', 'r', 't' => {},
                        'u' => {
                            if (self.pos + 4 > self.input.len) return error.BadEscape;
                            // Validate hex nibbles, but don't bother
                            // checking surrogate range here — `parseString`
                            // does the strict check during the decode pass.
                            var k: usize = 0;
                            while (k < 4) : (k += 1) {
                                _ = try hexNibble(self.input[self.pos + k]);
                            }
                            self.pos += 4;
                        },
                        else => return error.BadEscape,
                    }
                },
                else => {},
            }
        }
        return error.UnterminatedString;
    }

    /// Allocate-and-decode pass for a JSON string. Returns a freshly owned
    /// slice; the original input is not borrowed. Two-pass over the source
    /// (size, then write) so the output buffer is exactly sized.
    fn parseString(self: *Parser) ParseError![]const u8 {
        try self.expect('"');
        const body_start = self.pos;
        const decoded_len = try self.scanStringLen();
        // scanStringLen leaves pos one past the closing quote.
        const body_end_with_quote = self.pos;

        if (decoded_len == 0) return &[_]u8{};

        const buf = try self.alloc.alloc(self.alloc.ctx, decoded_len);
        const out = buf[0..decoded_len];

        var i = body_start;
        var w: usize = 0;
        // body_end_with_quote points one past `"`; the byte at -1 is `"`.
        while (i + 1 < body_end_with_quote) {
            const c = self.input[i];
            i += 1;
            if (c != '\\') {
                out[w] = c;
                w += 1;
                continue;
            }
            const esc = self.input[i];
            i += 1;
            switch (esc) {
                '"' => {
                    out[w] = '"';
                    w += 1;
                },
                '\\' => {
                    out[w] = '\\';
                    w += 1;
                },
                '/' => {
                    out[w] = '/';
                    w += 1;
                },
                'b' => {
                    out[w] = 0x08;
                    w += 1;
                },
                'f' => {
                    out[w] = 0x0C;
                    w += 1;
                },
                'n' => {
                    out[w] = '\n';
                    w += 1;
                },
                'r' => {
                    out[w] = '\r';
                    w += 1;
                },
                't' => {
                    out[w] = '\t';
                    w += 1;
                },
                'u' => {
                    const cp = try decodeU4(self.input[i .. i + 4]);
                    i += 4;
                    // Surrogate halves: rejected. wasi_setup is path-and-id
                    // strings; if we ever need full Unicode we'll add the
                    // pair-stitching logic here.
                    if (cp >= 0xD800 and cp <= 0xDFFF) return error.BadEscape;
                    w += try writeUtf8(out[w..], cp);
                },
                else => return error.BadEscape,
            }
        }

        std.debug.assert(w == decoded_len);
        return out;
    }

    /// Compute the decoded byte length of the JSON string starting at the
    /// current `pos` (just past the opening `"`). Advances `pos` to one
    /// past the closing `"`. Validates escapes the same way as
    /// `skipString` plus stricter `\uXXXX` surrogate handling.
    fn scanStringLen(self: *Parser) ParseError!usize {
        var n: usize = 0;
        while (self.pos < self.input.len) {
            const c = self.input[self.pos];
            self.pos += 1;
            switch (c) {
                '"' => return n,
                '\\' => {
                    if (self.pos >= self.input.len) return error.UnterminatedString;
                    const esc = self.input[self.pos];
                    self.pos += 1;
                    switch (esc) {
                        '"', '\\', '/', 'b', 'f', 'n', 'r', 't' => n += 1,
                        'u' => {
                            if (self.pos + 4 > self.input.len) return error.BadEscape;
                            const cp = try decodeU4(self.input[self.pos .. self.pos + 4]);
                            self.pos += 4;
                            if (cp >= 0xD800 and cp <= 0xDFFF) return error.BadEscape;
                            n += utf8Len(cp);
                        },
                        else => return error.BadEscape,
                    }
                },
                else => n += 1,
            }
        }
        return error.UnterminatedString;
    }
};

fn hexNibble(c: u8) ParseError!u8 {
    return switch (c) {
        '0'...'9' => c - '0',
        'a'...'f' => 10 + (c - 'a'),
        'A'...'F' => 10 + (c - 'A'),
        else => error.BadEscape,
    };
}

fn decodeU4(src: []const u8) ParseError!u21 {
    std.debug.assert(src.len == 4);
    var cp: u21 = 0;
    var k: usize = 0;
    while (k < 4) : (k += 1) {
        cp = (cp << 4) | @as(u21, try hexNibble(src[k]));
    }
    return cp;
}

fn utf8Len(cp: u21) usize {
    if (cp < 0x80) return 1;
    if (cp < 0x800) return 2;
    return 3; // BMP cap (no surrogate pairs → no 4-byte forms here).
}

fn writeUtf8(dst: []u8, cp: u21) ParseError!usize {
    if (cp < 0x80) {
        dst[0] = @intCast(cp);
        return 1;
    }
    if (cp < 0x800) {
        dst[0] = 0xC0 | @as(u8, @intCast(cp >> 6));
        dst[1] = 0x80 | @as(u8, @intCast(cp & 0x3F));
        return 2;
    }
    dst[0] = 0xE0 | @as(u8, @intCast(cp >> 12));
    dst[1] = 0x80 | @as(u8, @intCast((cp >> 6) & 0x3F));
    dst[2] = 0x80 | @as(u8, @intCast(cp & 0x3F));
    return 3;
}

/// Parse a JSON byte slice. All Value-internal slices live in memory the
/// allocator returns. The original `input` is NOT borrowed (so the caller
/// can reuse the input buffer afterward) — strings are decoded into fresh
/// memory.
pub fn parse(input: []const u8, alloc: Allocator) ParseError!Value {
    var p = Parser{ .input = input, .pos = 0, .alloc = alloc, .depth = 0 };
    const v = try p.parseValue();
    p.skipWs();
    if (p.pos != p.input.len) return error.Invalid;
    return v;
}

// -- tests -----------------------------------------------------------------

const TestArena = struct {
    backing: std.mem.Allocator,
    // Track aligned allocations so deinit can free them with the correct
    // alignment. Plain `[]u8` would lose the alignment metadata and trip
    // DebugAllocator's invalid-free check.
    allocations: std.ArrayList([]align(8) u8),

    fn init(backing: std.mem.Allocator) TestArena {
        return .{
            .backing = backing,
            .allocations = std.ArrayList([]align(8) u8).empty,
        };
    }

    fn deinit(self: *TestArena) void {
        for (self.allocations.items) |slice| self.backing.free(slice);
        self.allocations.deinit(self.backing);
    }

    fn allocator(self: *TestArena) Allocator {
        return .{ .ctx = self, .alloc = TestArena.allocFn };
    }

    fn allocFn(ctx: ?*anyopaque, size: usize) ParseError![]u8 {
        const self: *TestArena = @ptrCast(@alignCast(ctx.?));
        const buf = self.backing.alignedAlloc(u8, .@"8", size) catch
            return error.OutOfArenaMemory;
        self.allocations.append(self.backing, buf) catch return error.OutOfArenaMemory;
        return buf;
    }
};

test "parse wasi_setup-shaped JSON" {
    var arena = TestArena.init(std.testing.allocator);
    defer arena.deinit();

    const input = "{\"argv\":[\"asc\",\"/in/params\"],\"env\":{\"K\":\"V\"},\"cwd\":\"/scratch\"}";
    const v = try parse(input, arena.allocator());

    try std.testing.expect(v == .object_);
    const obj = v.object_;
    try std.testing.expectEqual(@as(usize, 3), obj.len);

    try std.testing.expectEqualStrings("argv", obj[0].key);
    try std.testing.expect(obj[0].value == .array_);
    const argv = obj[0].value.array_;
    try std.testing.expectEqual(@as(usize, 2), argv.len);
    try std.testing.expectEqualStrings("asc", argv[0].string_);
    try std.testing.expectEqualStrings("/in/params", argv[1].string_);

    try std.testing.expectEqualStrings("env", obj[1].key);
    try std.testing.expect(obj[1].value == .object_);
    const env = obj[1].value.object_;
    try std.testing.expectEqual(@as(usize, 1), env.len);
    try std.testing.expectEqualStrings("K", env[0].key);
    try std.testing.expectEqualStrings("V", env[0].value.string_);

    try std.testing.expectEqualStrings("cwd", obj[2].key);
    try std.testing.expectEqualStrings("/scratch", obj[2].value.string_);
}

test "parse top-level literals" {
    var arena = TestArena.init(std.testing.allocator);
    defer arena.deinit();

    try std.testing.expect((try parse("null", arena.allocator())) == .null_);
    try std.testing.expectEqual(true, (try parse("true", arena.allocator())).bool_);
    try std.testing.expectEqual(false, (try parse("false", arena.allocator())).bool_);
}

test "parse string escapes including \\uXXXX" {
    var arena = TestArena.init(std.testing.allocator);
    defer arena.deinit();

    const input = "{\"path\":\"a\\nb\\u0041c\"}";
    const v = try parse(input, arena.allocator());
    try std.testing.expect(v == .object_);
    const obj = v.object_;
    try std.testing.expectEqual(@as(usize, 1), obj.len);
    try std.testing.expectEqualStrings("path", obj[0].key);
    try std.testing.expectEqualStrings("a\nbAc", obj[0].value.string_);
}

test "parse rejects numbers" {
    var arena = TestArena.init(std.testing.allocator);
    defer arena.deinit();

    try std.testing.expectError(error.UnsupportedNumber, parse("42", arena.allocator()));
    try std.testing.expectError(
        error.UnsupportedNumber,
        parse("{\"n\":1}", arena.allocator()),
    );
    try std.testing.expectError(
        error.UnsupportedNumber,
        parse("[-3]", arena.allocator()),
    );
}

test "parse rejects surrogate pair halves" {
    var arena = TestArena.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectError(
        error.BadEscape,
        parse("\"\\uD800\"", arena.allocator()),
    );
}

test "parse rejects nesting beyond max depth" {
    var arena = TestArena.init(std.testing.allocator);
    defer arena.deinit();

    var buf: [200]u8 = undefined;
    var i: usize = 0;
    while (i < max_depth + 1) : (i += 1) buf[i] = '[';
    while (i < max_depth * 2 + 2) : (i += 1) buf[i] = ']';
    try std.testing.expectError(error.Invalid, parse(buf[0..i], arena.allocator()));
}

test "parse rejects trailing junk" {
    var arena = TestArena.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectError(error.Invalid, parse("true false", arena.allocator()));
}

test "parse handles empty array and object" {
    var arena = TestArena.init(std.testing.allocator);
    defer arena.deinit();

    const empty_arr = try parse("[]", arena.allocator());
    try std.testing.expect(empty_arr == .array_);
    try std.testing.expectEqual(@as(usize, 0), empty_arr.array_.len);

    const empty_obj = try parse("{}", arena.allocator());
    try std.testing.expect(empty_obj == .object_);
    try std.testing.expectEqual(@as(usize, 0), empty_obj.object_.len);
}

test "parse rejects unterminated string" {
    var arena = TestArena.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectError(
        error.UnterminatedString,
        parse("\"abc", arena.allocator()),
    );
}

test "parse rejects bad escape" {
    var arena = TestArena.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectError(
        error.BadEscape,
        parse("\"\\x\"", arena.allocator()),
    );
}
