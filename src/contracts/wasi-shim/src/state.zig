// Per-run mutable state for the WASI shim. Owned at module scope; reset by
// `init` at the top of every `run` invocation.
//
// **Slice-lifetime contract.** Every `[]const u8` (or slice-of-slices) field
// stored on `State` is owned by the shim's bump arena: `init` copies the
// caller's bytes into freshly-bumped memory before returning. This severs the
// borrowed-slice contract from `scaffold/env.zig` ("valid until the next
// `alloc` call"), so callers may freely interleave `state.init`,
// `env.contractMetadata(...)`, and any other allocation that follows.
//
// Without this copy, a future setup path that does
//   `const md = env.contractMetadata(...);`
//   `state.init(.{ .argv = parsed_argv, ... });`
// would silently corrupt state every time `init` ran an `alloc` for the
// FD table or for `md`'s parse buffer in between borrowing the bytes and
// reading them.
//
// Reads happen through `current()`. There's a single instance — the shim
// runs one program at a time per `run` call, and re-entry isn't a thing in
// the deterministic execution model.

const std = @import("std");

const vfs = @import("vfs/vfs.zig");

pub const EnvEntry = struct { key: []const u8, val: []const u8 };

/// Bump allocator handed in by the caller. `state.init` uses this to copy
/// every borrowed slice into shim-owned memory. The contract is the same
/// as `main.alloc` in production: never returns null (run() owns the budget),
/// so the function pointer's return is a plain `[]u8`.
pub const Allocator = struct {
    ctx: ?*anyopaque,
    alloc: *const fn (ctx: ?*anyopaque, size: usize) []u8,

    fn dupe(self: Allocator, src: []const u8) []const u8 {
        if (src.len == 0) return &[_]u8{};
        const buf = self.alloc(self.ctx, src.len);
        @memcpy(buf, src);
        return buf;
    }
};

pub const State = struct {
    /// Counter shared by `random_get` + `/dev/random` + `/dev/urandom`.
    /// The PRNG seed itself is fixed-zero for now (see abi/random.zig);
    /// the counter still advances per-block to keep the stream
    /// deterministic-but-distinct across calls within a run.
    prng_counter: u64,
    /// Counter for `clock_time_get(MONOTONIC)` and the CPUTIME family.
    /// Starts at 0; advances by 1 per observation. Returned ns is the
    /// post-increment value (so the first call returns 1).
    monotonic_counter: u64,
    /// argv from `wasi_setup`. Each entry is bare arg bytes (no NUL).
    /// Owned by the shim's bump arena (copied by `init`).
    argv: []const []const u8,
    /// env from `wasi_setup`. Order preserved as listed.
    /// Owned by the shim's bump arena (copied by `init`).
    env: []const EnvEntry,
    /// Working directory from `wasi_setup`. Defaults to "/".
    /// Owned by the shim's bump arena (copied by `init`).
    cwd: []const u8,
    /// Preopen paths from `wasi_setup` (e.g. `/in`, `/out`, `/scratch`, `/dev`).
    /// Owned by the shim's bump arena (copied by `init`).
    preopens: []const []const u8,
    /// FD table populated by setup (Wave B3) and consumed by every `fd_*` /
    /// `path_*` handler. Reset to an empty table on each `init`.
    fd_table: vfs.FdTable,
};

pub const InitArgs = struct {
    /// All slice fields below are borrowed only across this `init` call:
    /// `init` copies them into shim-owned memory via `allocator` before
    /// returning. After `init` returns, callers may drop or invalidate the
    /// originals freely.
    argv: []const []const u8 = &.{},
    env: []const EnvEntry = &.{},
    cwd: []const u8 = "/",
    preopens: []const []const u8 = &.{ "/in", "/out", "/scratch", "/dev" },
};

/// Singleton storage. Lives in BSS. Every slice it holds references the
/// shim's own bump arena (filled by `init`), not caller memory.
var current_state: State = undefined;

/// Initialise the per-run state. Call once at the top of `run`. The
/// `allocator` is used to copy every borrowed slice out of `args` so the
/// caller is free to drop the originals once `init` returns.
pub fn init(allocator: Allocator, args: InitArgs) void {
    current_state = .{
        .prng_counter = 0,
        .monotonic_counter = 0,
        .argv = dupeSlices(allocator, args.argv),
        .env = dupeEnv(allocator, args.env),
        .cwd = allocator.dupe(args.cwd),
        .preopens = dupeSlices(allocator, args.preopens),
        .fd_table = vfs.FdTable.init(),
    };
}

fn dupeSlices(allocator: Allocator, src: []const []const u8) []const []const u8 {
    if (src.len == 0) return &[_][]const u8{};
    const bytes = allocator.alloc(allocator.ctx, src.len * @sizeOf([]const u8));
    const out: [][]const u8 = @as(
        [*][]const u8,
        @ptrCast(@alignCast(bytes.ptr)),
    )[0..src.len];
    for (src, 0..) |s, i| out[i] = allocator.dupe(s);
    return out;
}

fn dupeEnv(allocator: Allocator, src: []const EnvEntry) []const EnvEntry {
    if (src.len == 0) return &[_]EnvEntry{};
    const bytes = allocator.alloc(allocator.ctx, src.len * @sizeOf(EnvEntry));
    const out: []EnvEntry = @as(
        [*]EnvEntry,
        @ptrCast(@alignCast(bytes.ptr)),
    )[0..src.len];
    for (src, 0..) |e, i| out[i] = .{
        .key = allocator.dupe(e.key),
        .val = allocator.dupe(e.val),
    };
    return out;
}

/// Borrow the current state. Lifetime: until the next `init`.
pub fn current() *State {
    return &current_state;
}

// -- tests -----------------------------------------------------------------
//
// Tests use a fixed-buffer bump arena to mirror the shipping behaviour:
// every borrowed slice in `InitArgs` is copied into arena memory.

const TestArena = struct {
    buf: []u8,
    pos: usize,

    fn init(buf: []u8) TestArena {
        return .{ .buf = buf, .pos = 0 };
    }

    fn allocator(self: *TestArena) Allocator {
        return .{ .ctx = self, .alloc = allocFn };
    }

    fn allocFn(ctx: ?*anyopaque, size: usize) []u8 {
        const self: *TestArena = @ptrCast(@alignCast(ctx.?));
        // 8-byte align so slices of pointers / EnvEntry land aligned.
        const base = @intFromPtr(self.buf.ptr) + self.pos;
        const aligned = std.mem.alignForward(usize, base, 8);
        const start = aligned - @intFromPtr(self.buf.ptr);
        const end = start + size;
        std.debug.assert(end <= self.buf.len);
        self.pos = end;
        return self.buf[start..end];
    }
};

test "init resets counters" {
    var arena_buf: [4096]u8 = undefined;
    var arena = TestArena.init(&arena_buf);

    init(arena.allocator(), .{});
    current().prng_counter = 99;
    current().monotonic_counter = 77;

    arena.pos = 0;
    init(arena.allocator(), .{});
    try std.testing.expectEqual(@as(u64, 0), current().prng_counter);
    try std.testing.expectEqual(@as(u64, 0), current().monotonic_counter);
}

test "init copies borrowed slices into arena memory" {
    var arena_buf: [4096]u8 = undefined;
    var arena = TestArena.init(&arena_buf);

    var argv_buf = [_]u8{ 'a', 'r', 'g', '0' };
    var argv_storage = [_][]const u8{argv_buf[0..]};
    var key_buf = [_]u8{ 'K', 'E', 'Y' };
    var val_buf = [_]u8{ 'V', 'A', 'L' };
    var env_storage = [_]EnvEntry{.{ .key = key_buf[0..], .val = val_buf[0..] }};
    var cwd_buf = [_]u8{ '/', 'a' };
    var preopen_buf = [_]u8{ '/', 'i', 'n' };
    var preopens_storage = [_][]const u8{preopen_buf[0..]};

    init(arena.allocator(), .{
        .argv = argv_storage[0..],
        .env = env_storage[0..],
        .cwd = cwd_buf[0..],
        .preopens = preopens_storage[0..],
    });

    // Mutate the originals to prove the state owns its own copies.
    @memset(&argv_buf, 0);
    @memset(&key_buf, 0);
    @memset(&val_buf, 0);
    @memset(&cwd_buf, 0);
    @memset(&preopen_buf, 0);

    const s = current();
    try std.testing.expectEqual(@as(usize, 1), s.argv.len);
    try std.testing.expectEqualStrings("arg0", s.argv[0]);
    try std.testing.expectEqual(@as(usize, 1), s.env.len);
    try std.testing.expectEqualStrings("KEY", s.env[0].key);
    try std.testing.expectEqualStrings("VAL", s.env[0].val);
    try std.testing.expectEqualStrings("/a", s.cwd);
    try std.testing.expectEqual(@as(usize, 1), s.preopens.len);
    try std.testing.expectEqualStrings("/in", s.preopens[0]);
}

test "init creates an empty fd_table" {
    var arena_buf: [4096]u8 = undefined;
    var arena = TestArena.init(&arena_buf);

    init(arena.allocator(), .{});
    try std.testing.expectEqual(vfs.FdTable.MAX_FDS, current().fd_table.free_count);
}
