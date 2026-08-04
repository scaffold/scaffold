// Pure path-encoding + wire-format helpers shared by `paths.zig`. Split out
// so the bulk of the testable surface lives in a file that doesn't import
// `env.zig` (and therefore doesn't pull in the `scaffold_env.*` externs).
// `paths.zig` itself is wasm-only because of the env imports; everything
// here builds and tests on the native target.
//
// See docs/design/wasi-shim.md ("Path encoding of binary values" and
// "Record-key paths") for the rules these helpers implement.

const std = @import("std");

const state_mod = @import("../state.zig");

// -- contract-side wire constants ----------------------------------------

/// SHA-256("result-contract"); matches `RECORD_CONTRACT` in
/// `src/core/Block.ts`. Cross-checked at the time of writing via deno eval;
/// updating one side without the other will silently route `/out/record`
/// outputs to the wrong contract.
pub const RECORD_CONTRACT_HASH: [32]u8 = .{
    0xd0, 0x8a, 0x9d, 0xef, 0xb6, 0x95, 0xd1, 0xd7,
    0x95, 0x88, 0x4f, 0xcb, 0xa9, 0xa8, 0x5d, 0xab,
    0x23, 0x39, 0x81, 0x4f, 0x46, 0x58, 0x98, 0x90,
    0x84, 0x19, 0xa7, 0x49, 0x43, 0x95, 0xde, 0xc9,
};

// -- path-segment decoders -----------------------------------------------

/// `0x` + 64 hex chars → 32-byte hash. Returns null on length mismatch,
/// missing prefix, or non-hex digit. The whole-prefix check catches the
/// literal "0x..." encoding mistake of treating the rest as raw bytes.
pub fn decodeContractHash(name: []const u8) ?[32]u8 {
    if (name.len != 66) return null;
    if (name[0] != '0' or name[1] != 'x') return null;
    var out: [32]u8 = undefined;
    _ = std.fmt.hexToBytes(&out, name[2..]) catch return null;
    return out;
}

/// UTF-8 by default; `0x`-prefix switches to hex-decode of the rest.
/// Documented escape: a literal record key or params value that *starts*
/// with the two ASCII bytes `0x` MUST be passed in hex form -- the shim
/// has no quote-escape, by design (see "Path encoding of binary values").
pub fn decodeParams(name: []const u8, alloc: state_mod.Allocator) ?[]const u8 {
    if (name.len >= 2 and name[0] == '0' and name[1] == 'x') {
        const hex = name[2..];
        if (hex.len % 2 != 0) return null;
        const buf = alloc.alloc(alloc.ctx, hex.len / 2);
        _ = std.fmt.hexToBytes(buf, hex) catch return null;
        return buf;
    }
    return name;
}

/// Join `segments` with `/`. The first segment may be `0x`-prefixed, in
/// which case the segment is treated as the hex form of the WHOLE key
/// (per the design's "if a literal record key starts with `0x` ..." rule).
/// Multi-segment `0x`-prefixed paths (rare; the design says the `0x` form
/// is one segment in practice) fall through to UTF-8 join.
pub fn decodeRecordKey(
    segments: []const []const u8,
    alloc: state_mod.Allocator,
) ?[]const u8 {
    if (segments.len == 0) return &[_]u8{};

    if (segments.len == 1 and segments[0].len >= 2 and
        segments[0][0] == '0' and segments[0][1] == 'x')
    {
        const hex = segments[0][2..];
        if (hex.len % 2 != 0) return null;
        const buf = alloc.alloc(alloc.ctx, hex.len / 2);
        _ = std.fmt.hexToBytes(buf, hex) catch return null;
        return buf;
    }

    var total: usize = 0;
    for (segments) |s| total += s.len;
    if (segments.len > 1) total += segments.len - 1;

    const out = alloc.alloc(alloc.ctx, total);
    var pos: usize = 0;
    for (segments, 0..) |s, i| {
        if (i > 0) {
            out[pos] = '/';
            pos += 1;
        }
        @memcpy(out[pos..][0..s.len], s);
        pos += s.len;
    }
    return out;
}

/// Base-10 decimal in i128 range. `null` on parse failure (empty, non-digits
/// after the optional sign, overflow). Leading `+` accepted for symmetry
/// with `-` even though the WASI contract author would normally omit it.
pub fn decodeAmount(name: []const u8) ?i128 {
    return std.fmt.parseInt(i128, name, 10) catch null;
}

// -- shim-arena helpers --------------------------------------------------

/// `state_mod.Allocator.dupe` is file-private inside `state.zig`. Mirror its
/// shape here so paths.zig can keep its allocator interactions explicit.
pub fn dupeBytes(alloc: state_mod.Allocator, src: []const u8) []const u8 {
    if (src.len == 0) return &[_]u8{};
    const buf = alloc.alloc(alloc.ctx, src.len);
    @memcpy(buf, src);
    return buf;
}

/// Append `name` to `segments`, allocating a fresh `[][]const u8` in the
/// arena. We dupe `name` so the resulting slice is safe to keep beyond the
/// caller's stack frame (the abi layer hands us bytes from program memory
/// that may be reused).
pub fn appendSegment(
    alloc: state_mod.Allocator,
    segments: []const []const u8,
    name: []const u8,
) []const []const u8 {
    const new_len = segments.len + 1;
    const arr_bytes = alloc.alloc(alloc.ctx, new_len * @sizeOf([]const u8));
    const out: [][]const u8 = @as(
        [*][]const u8,
        @ptrCast(@alignCast(arr_bytes.ptr)),
    )[0..new_len];
    @memcpy(out[0..segments.len], segments);
    out[segments.len] = dupeBytes(alloc, name);
    return out;
}

// -- wire encoders -------------------------------------------------------

/// Encode a Verifier on the wire: 32-byte contract hash + u32 LE params
/// length + params bytes. Mirror of `encodeVerifier` in
/// `src/plugins/wasm/WasmWireCodec.ts`.
pub fn encodeVerifier(
    alloc: state_mod.Allocator,
    contract_hash: [32]u8,
    params: []const u8,
) []const u8 {
    const total = 32 + 4 + params.len;
    const buf = alloc.alloc(alloc.ctx, total);
    @memcpy(buf[0..32], &contract_hash);
    std.mem.writeInt(u32, buf[32..36], @intCast(params.len), .little);
    @memcpy(buf[36..][0..params.len], params);
    return buf;
}

/// Encode a fully-formed Output: verifier + i128 LE value + u32 LE body
/// length + body. Mirror of `encodeOutput` in WasmWireCodec.ts.
pub fn encodeOutput(
    alloc: state_mod.Allocator,
    verifier: []const u8,
    value: i128,
    body: []const u8,
) []const u8 {
    const total = verifier.len + 16 + 4 + body.len;
    const buf = alloc.alloc(alloc.ctx, total);
    @memcpy(buf[0..verifier.len], verifier);
    std.mem.writeInt(i128, buf[verifier.len..][0..16], value, .little);
    std.mem.writeInt(u32, buf[verifier.len + 16 ..][0..4], @intCast(body.len), .little);
    @memcpy(buf[verifier.len + 16 + 4 ..][0..body.len], body);
    return buf;
}

/// Strip the (i128 value, u32 body-length) header from a `request_body` /
/// `contract_metadata` reply and return the body bytes. Returns
/// `error.InvalidReply` on any short read; the caller surfaces this as
/// `vfs.VfsError.InvalidArgument`.
pub fn unpackBody(reply: []const u8) error{InvalidReply}![]const u8 {
    if (reply.len < 16 + 4) return error.InvalidReply;
    const body_len = std.mem.readInt(u32, reply[16..20], .little);
    if (reply.len < 20 + body_len) return error.InvalidReply;
    return reply[20 .. 20 + body_len];
}

// -- tests ---------------------------------------------------------------

const testing = std.testing;

const TestArena = struct {
    buf: []u8,
    pos: usize = 0,

    fn allocator(self: *TestArena) state_mod.Allocator {
        return .{ .ctx = self, .alloc = allocFn };
    }

    fn allocFn(ctx: ?*anyopaque, size: usize) []u8 {
        const self: *TestArena = @ptrCast(@alignCast(ctx.?));
        const base = @intFromPtr(self.buf.ptr) + self.pos;
        const aligned = std.mem.alignForward(usize, base, 8);
        const start = aligned - @intFromPtr(self.buf.ptr);
        const end = start + size;
        std.debug.assert(end <= self.buf.len);
        self.pos = end;
        return self.buf[start..end];
    }
};

test "decodeContractHash accepts 0x + 64 hex" {
    const name = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const got = decodeContractHash(name);
    try testing.expect(got != null);
    try testing.expectEqual(@as(u8, 0x01), got.?[0]);
    try testing.expectEqual(@as(u8, 0xef), got.?[31]);
}

test "decodeContractHash rejects bad prefix, length, hex" {
    try testing.expect(decodeContractHash("00abcdef") == null);
    try testing.expect(decodeContractHash("0xshort") == null);
    try testing.expect(decodeContractHash(
        "1x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ) == null);
    try testing.expect(decodeContractHash(
        "0xZZ23456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ) == null);
}

test "decodeParams: UTF-8 default, 0x switches to hex" {
    var buf: [256]u8 = undefined;
    var arena: TestArena = .{ .buf = &buf };

    const utf8 = decodeParams("hello", arena.allocator()).?;
    try testing.expectEqualStrings("hello", utf8);

    arena.pos = 0;
    const hex = decodeParams("0x68656c6c6f", arena.allocator()).?;
    try testing.expectEqualStrings("hello", hex);

    arena.pos = 0;
    try testing.expect(decodeParams("0xab1", arena.allocator()) == null);
}

test "decodeRecordKey joins UTF-8 segments with /" {
    var buf: [256]u8 = undefined;
    var arena: TestArena = .{ .buf = &buf };

    const segs = [_][]const u8{ "a", "b", "c" };
    const got = decodeRecordKey(&segs, arena.allocator()).?;
    try testing.expectEqualStrings("a/b/c", got);
}

test "decodeRecordKey: empty input -> empty key" {
    var buf: [16]u8 = undefined;
    var arena: TestArena = .{ .buf = &buf };
    const got = decodeRecordKey(&[_][]const u8{}, arena.allocator()).?;
    try testing.expectEqual(@as(usize, 0), got.len);
}

test "decodeRecordKey: 0x-prefix single segment hex-decodes whole key" {
    var buf: [256]u8 = undefined;
    var arena: TestArena = .{ .buf = &buf };
    const segs = [_][]const u8{"0x68656c6c6f"};
    const got = decodeRecordKey(&segs, arena.allocator()).?;
    try testing.expectEqualStrings("hello", got);
}

test "decodeAmount: positive, negative, invalid" {
    try testing.expectEqual(@as(i128, 123), decodeAmount("123").?);
    try testing.expectEqual(@as(i128, -5), decodeAmount("-5").?);
    try testing.expectEqual(@as(i128, 0), decodeAmount("0").?);
    try testing.expect(decodeAmount("foo") == null);
    try testing.expect(decodeAmount("") == null);
    try testing.expect(decodeAmount("12x") == null);
}

test "encodeVerifier produces hash || u32 plen || params" {
    var buf: [256]u8 = undefined;
    var arena: TestArena = .{ .buf = &buf };

    const hash = [_]u8{0xAB} ** 32;
    const got = encodeVerifier(arena.allocator(), hash, "params");
    try testing.expectEqual(@as(usize, 32 + 4 + 6), got.len);
    try testing.expectEqualSlices(u8, &hash, got[0..32]);
    try testing.expectEqual(@as(u8, 6), got[32]); // u32 LE first byte
    try testing.expectEqualStrings("params", got[36..42]);
}

test "encodeOutput round-trips i128 value bytes for value=0" {
    var arena_buf: [256]u8 = undefined;
    var arena: TestArena = .{ .buf = &arena_buf };

    const verifier = "v";
    const body = "b";
    const out = encodeOutput(arena.allocator(), verifier, 0, body);
    // verifier(1) + i128(16) + u32(4) + body(1) = 22.
    try testing.expectEqual(@as(usize, 22), out.len);
    try testing.expectEqual(@as(u8, 'v'), out[0]);
    var i: usize = 1;
    while (i < 17) : (i += 1) try testing.expectEqual(@as(u8, 0), out[i]);
    try testing.expectEqual(@as(u8, 1), out[17]);
    try testing.expectEqual(@as(u8, 'b'), out[21]);
}

test "encodeOutput two's-complement encodes negative i128" {
    var arena_buf: [128]u8 = undefined;
    var arena: TestArena = .{ .buf = &arena_buf };

    const out = encodeOutput(arena.allocator(), &[_]u8{}, -1, &[_]u8{});
    try testing.expectEqual(@as(usize, 20), out.len);
    var i: usize = 0;
    while (i < 16) : (i += 1) try testing.expectEqual(@as(u8, 0xFF), out[i]);
}

test "unpackBody strips i128 + u32 prefix and returns body" {
    var reply: [24]u8 = undefined;
    @memset(reply[0..16], 0);
    std.mem.writeInt(u32, reply[16..20], 4, .little);
    @memcpy(reply[20..24], "abcd");
    const body = try unpackBody(&reply);
    try testing.expectEqualStrings("abcd", body);
}

test "unpackBody rejects truncated reply" {
    var short: [10]u8 = undefined;
    try testing.expectError(error.InvalidReply, unpackBody(&short));
}

test "appendSegment dupes the new segment" {
    var arena_buf: [256]u8 = undefined;
    var arena: TestArena = .{ .buf = &arena_buf };

    var name_buf = [_]u8{ 'f', 'o', 'o' };
    const out = appendSegment(arena.allocator(), &[_][]const u8{}, name_buf[0..]);
    try testing.expectEqual(@as(usize, 1), out.len);
    try testing.expectEqualStrings("foo", out[0]);

    @memset(&name_buf, 0);
    try testing.expectEqualStrings("foo", out[0]);
}
