const std = @import("std");
const json = std.json;
const Io = std.Io;

var out_buf: [8192]u8 = undefined;

const Demo = struct {
    name: []const u8,
    age: i32,
    neg: i32,
    scores: []const i32,
    pi: f64,
    active: bool,
    deleted: ?u8,
};

export fn get_buf_ptr() [*]u8 {
    return &out_buf;
}

fn writeJson(v: anytype) usize {
    var w = Io.Writer.fixed(&out_buf);
    json.Stringify.value(v, .{}, &w) catch return 0;
    return w.end;
}

// Serialize a struct with all JSON types
export fn json_demo() usize {
    return writeJson(Demo{
        .name = "hello\nworld",
        .age = 42,
        .neg = -999,
        .scores = &[_]i32{ 1, 2, 3 },
        .pi = 3.14159265,
        .active = true,
        .deleted = null,
    });
}

// Individual type serializers to ensure all codepaths survive LTO

export fn json_string(ptr: [*]const u8, len: usize) usize {
    return writeJson(ptr[0..len]);
}

export fn json_i32(val: i32) usize {
    return writeJson(val);
}

export fn json_f64(val: f64) usize {
    return writeJson(val);
}

export fn json_bool(val: u32) usize {
    return writeJson(val != 0);
}

export fn json_null() usize {
    return writeJson(@as(?u8, null));
}

export fn json_array() usize {
    return writeJson([_]i32{ 10, 20, 30 });
}

export fn json_object() usize {
    const obj = struct { foo: i32, bar: []const u8 }{ .foo = 1, .bar = "baz" };
    return writeJson(obj);
}

// ==== Deserialization ====

var alloc_buf: [65536]u8 = undefined;

fn allocator() std.heap.FixedBufferAllocator {
    return std.heap.FixedBufferAllocator.init(&alloc_buf);
}

// Parse a full struct from JSON
export fn parse_demo(ptr: [*]const u8, len: usize) i32 {
    var fba = allocator();
    const parsed = json.parseFromSlice(Demo, fba.allocator(), ptr[0..len], .{}) catch return -1;
    defer parsed.deinit();
    return parsed.value.age + parsed.value.neg;
}

// Parse individual types

export fn parse_i32(ptr: [*]const u8, len: usize) i32 {
    var fba = allocator();
    const parsed = json.parseFromSlice(i32, fba.allocator(), ptr[0..len], .{}) catch return -1;
    defer parsed.deinit();
    return parsed.value;
}

export fn parse_f64(ptr: [*]const u8, len: usize) f64 {
    var fba = allocator();
    const parsed = json.parseFromSlice(f64, fba.allocator(), ptr[0..len], .{}) catch return -1;
    defer parsed.deinit();
    return parsed.value;
}

export fn parse_bool(ptr: [*]const u8, len: usize) u32 {
    var fba = allocator();
    const parsed = json.parseFromSlice(bool, fba.allocator(), ptr[0..len], .{}) catch return 2;
    defer parsed.deinit();
    return if (parsed.value) 1 else 0;
}

export fn parse_string(ptr: [*]const u8, len: usize) usize {
    var fba = allocator();
    const parsed = json.parseFromSlice([]const u8, fba.allocator(), ptr[0..len], .{}) catch return 0;
    defer parsed.deinit();
    // Copy result to out_buf so caller can read it
    const s = parsed.value;
    const n = @min(s.len, out_buf.len);
    @memcpy(out_buf[0..n], s[0..n]);
    return n;
}

export fn parse_array(ptr: [*]const u8, len: usize) i32 {
    var fba = allocator();
    const parsed = json.parseFromSlice([]const i32, fba.allocator(), ptr[0..len], .{}) catch return -1;
    defer parsed.deinit();
    var sum: i32 = 0;
    for (parsed.value) |v| sum += v;
    return sum;
}

// Parse into dynamic Value (covers all JSON types generically)
export fn parse_dynamic(ptr: [*]const u8, len: usize) usize {
    var fba = allocator();
    const parsed = json.parseFromSlice(json.Value, fba.allocator(), ptr[0..len], .{}) catch return 0;
    defer parsed.deinit();
    return writeJson(parsed.value);
}
