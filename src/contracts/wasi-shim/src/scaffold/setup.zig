// Reads the `wasi_setup` JSON record from contract metadata, applies the
// per-field defaults below, and returns a `ParsedSetup` `main.run` hands to
// `state.init` and `populateFdTable`.
//
// Defaults table (applied independently per missing field, so a partial
// record fills in only the gaps):
//   argv         = ["program"]    -- wasi-libc / most runtimes assume argv[0]
//                                    exists; the design doc mentions `[]` as
//                                    the spec default but that's a footgun.
//   env          = []
//   cwd          = "/"
//   preopens     = ["/in", "/out", "/scratch", "/dev"]
//   stdin        = "/dev/null"
//   stdout       = "/out/debug"
//   stderr       = "/out/debug"
//   extra_fds    = []
//
// Forward-compatibility rules:
//   - Unknown keys at the top level of the record: silently ignored. Lets
//     us add new fields later without breaking older shims.
//   - Unknown keys inside `env` or `extra_fds`: those have a defined schema,
//     so we don't ignore unknowns there -- the only "unknown" failure mode
//     is a non-numeric `extra_fds` key, which surfaces as InvalidExtraFdKey.
//
// `wasi_setup` absence: documented as a design gap. Calling
// `env.contractMetadata` on a missing record currently *rejects the whole
// run* (the host throws ContractRejection, which we cannot catch from
// inside wasm). We treat an empty body as "use defaults"; total absence
// surfaces as a run rejection. See TODO.md for the WasmHostBridge change
// that would let this module fall through cleanly.

const std = @import("std");

const json = @import("../json.zig");
const env = @import("env.zig");
const codec = @import("paths_codec.zig");
const paths = @import("paths.zig");
const state_mod = @import("../state.zig");
const vfs = @import("../vfs/vfs.zig");

pub const ExtraFd = struct {
    fd: u32,
    path: []const u8,
};

pub const ParsedSetup = struct {
    /// argv strings -- already copied into shim memory by `read`.
    argv: []const []const u8,
    env: []const state_mod.EnvEntry,
    cwd: []const u8,
    preopens: []const []const u8,
    /// FD bindings. Defaults: stdin = "/dev/null", stdout = "/out/debug",
    /// stderr = "/out/debug".
    stdin_path: []const u8,
    stdout_path: []const u8,
    stderr_path: []const u8,
    /// Extra numeric FDs beyond stdio + preopens. Each entry is (fd, path).
    extra_fds: []const ExtraFd,
};

pub const SetupError = error{
    /// `extra_fds` has a key that didn't parse as a u32.
    InvalidExtraFdKey,
    /// Top-level value isn't an object, or a typed field has the wrong shape
    /// (e.g. `argv` is a string instead of an array).
    InvalidShape,
    /// JSON parse failure -- malformed body, depth overrun, etc.
    BadJson,
    /// The shim's bump arena ran out of room while parsing or dup'ing.
    OutOfArenaMemory,
};

/// Verifier params for the `wasi_setup` metadata record.
const WASI_SETUP_KEY: []const u8 = "wasi_setup";

const DEFAULT_ARGV: []const []const u8 = &[_][]const u8{"program"};
const DEFAULT_PREOPENS: []const []const u8 = &[_][]const u8{ "/in", "/out", "/scratch", "/dev" };

/// Read the `wasi_setup` record (if any), parse it, and return a
/// `ParsedSetup` with all slices owned by the shim's bump arena via `alloc`.
/// Defaults are applied per-field for missing keys.
///
/// `contract_hash` is passed in (rather than read off `state.current()`)
/// because `read` runs before `state.init` -- the parsed setup is one of
/// the inputs to `state.init`. Caller obtains the hash via
/// `env.contractHash()`.
pub fn read(alloc: state_mod.Allocator, contract_hash: [32]u8) SetupError!ParsedSetup {
    const verifier = codec.encodeVerifier(alloc, contract_hash, WASI_SETUP_KEY);
    const reply = env.contractMetadata(verifier);

    // unpackBody peels the (i128 value, u32 body_len) header. A truncated or
    // missing reply is treated as "use defaults" so a contract author who
    // omits the record still boots; the design says absent record == defaults.
    const body = codec.unpackBody(reply) catch return defaults();
    if (body.len == 0) return defaults();
    return parseSetupJson(body, alloc);
}

/// Returns a ParsedSetup with every field set to its documented default.
fn defaults() ParsedSetup {
    return .{
        .argv = DEFAULT_ARGV,
        .env = &[_]state_mod.EnvEntry{},
        .cwd = "/",
        .preopens = DEFAULT_PREOPENS,
        .stdin_path = "/dev/null",
        .stdout_path = "/out/debug",
        .stderr_path = "/out/debug",
        .extra_fds = &[_]ExtraFd{},
    };
}

/// Parse a JSON `wasi_setup` body into `ParsedSetup`. Pulled out so unit
/// tests can exercise it without an env dependency.
pub fn parseSetupJson(body: []const u8, alloc: state_mod.Allocator) SetupError!ParsedSetup {
    var json_alloc_ctx = JsonAllocCtx{ .inner = alloc };
    const json_alloc: json.Allocator = .{
        .ctx = &json_alloc_ctx,
        .alloc = JsonAllocCtx.allocFn,
    };

    const value = json.parse(body, json_alloc) catch |err| return mapJsonError(err);
    if (value != .object_) return error.InvalidShape;
    const obj = value.object_;

    var out = defaults();

    for (obj) |entry| {
        if (std.mem.eql(u8, entry.key, "argv")) {
            out.argv = try parseStringArray(entry.value, alloc);
        } else if (std.mem.eql(u8, entry.key, "env")) {
            out.env = try parseEnv(entry.value, alloc);
        } else if (std.mem.eql(u8, entry.key, "cwd")) {
            out.cwd = try parseString(entry.value);
        } else if (std.mem.eql(u8, entry.key, "preopens")) {
            out.preopens = try parseStringArray(entry.value, alloc);
        } else if (std.mem.eql(u8, entry.key, "stdin")) {
            out.stdin_path = try parseString(entry.value);
        } else if (std.mem.eql(u8, entry.key, "stdout")) {
            out.stdout_path = try parseString(entry.value);
        } else if (std.mem.eql(u8, entry.key, "stderr")) {
            out.stderr_path = try parseString(entry.value);
        } else if (std.mem.eql(u8, entry.key, "extra_fds")) {
            out.extra_fds = try parseExtraFds(entry.value, alloc);
        }
        // Unknown top-level keys: silently ignored (forward-compat).
    }

    return out;
}

fn parseString(value: json.Value) SetupError![]const u8 {
    if (value != .string_) return error.InvalidShape;
    return value.string_;
}

fn parseStringArray(
    value: json.Value,
    alloc: state_mod.Allocator,
) SetupError![]const []const u8 {
    if (value != .array_) return error.InvalidShape;
    const items = value.array_;
    if (items.len == 0) return &[_][]const u8{};

    const bytes = alloc.alloc(alloc.ctx, items.len * @sizeOf([]const u8));
    const out: [][]const u8 = @as(
        [*][]const u8,
        @ptrCast(@alignCast(bytes.ptr)),
    )[0..items.len];
    for (items, 0..) |item, i| {
        if (item != .string_) return error.InvalidShape;
        out[i] = item.string_;
    }
    return out;
}

fn parseEnv(
    value: json.Value,
    alloc: state_mod.Allocator,
) SetupError![]const state_mod.EnvEntry {
    if (value != .object_) return error.InvalidShape;
    const entries = value.object_;
    if (entries.len == 0) return &[_]state_mod.EnvEntry{};

    const bytes = alloc.alloc(alloc.ctx, entries.len * @sizeOf(state_mod.EnvEntry));
    const out: []state_mod.EnvEntry = @as(
        [*]state_mod.EnvEntry,
        @ptrCast(@alignCast(bytes.ptr)),
    )[0..entries.len];
    for (entries, 0..) |e, i| {
        if (e.value != .string_) return error.InvalidShape;
        out[i] = .{ .key = e.key, .val = e.value.string_ };
    }
    return out;
}

fn parseExtraFds(
    value: json.Value,
    alloc: state_mod.Allocator,
) SetupError![]const ExtraFd {
    if (value != .object_) return error.InvalidShape;
    const entries = value.object_;
    if (entries.len == 0) return &[_]ExtraFd{};

    const bytes = alloc.alloc(alloc.ctx, entries.len * @sizeOf(ExtraFd));
    const out: []ExtraFd = @as(
        [*]ExtraFd,
        @ptrCast(@alignCast(bytes.ptr)),
    )[0..entries.len];
    for (entries, 0..) |e, i| {
        if (e.value != .string_) return error.InvalidShape;
        const fd = std.fmt.parseInt(u32, e.key, 10) catch
            return error.InvalidExtraFdKey;
        out[i] = .{ .fd = fd, .path = e.value.string_ };
    }
    return out;
}

fn mapJsonError(err: json.ParseError) SetupError {
    return switch (err) {
        error.OutOfArenaMemory => error.OutOfArenaMemory,
        else => error.BadJson,
    };
}

// Adapter from `state_mod.Allocator` (no-error) to `json.Allocator`
// (ParseError-returning). The shim's bump never returns null in production
// (wasm trap on OOM), so we forward straight through.
const JsonAllocCtx = struct {
    inner: state_mod.Allocator,

    fn allocFn(ctx: ?*anyopaque, size: usize) json.ParseError![]u8 {
        const self: *JsonAllocCtx = @ptrCast(@alignCast(ctx.?));
        return self.inner.alloc(self.inner.ctx, size);
    }
};

// -- FD table population --------------------------------------------------

/// Open stdio + preopens + extra_fds against `paths.rootNode()` and write
/// the resulting FdEntry slots into `state.current().fd_table`. Stdio
/// (fds 0/1/2) are allocated first, then preopens (fds 3..3+N), then any
/// extra_fds direct-write into their requested slots.
///
/// We rely on `FdTable.init`'s LIFO seeding (slot 0 first) to land stdio at
/// 0/1/2 -- there's no `setFixed`-style helper because the natural alloc
/// order already produces the WASI-required layout. Extra fds beyond the
/// preopen tail jump the queue via direct writes; the surrounding free-list
/// is left intact and may hand out the (now-occupied) slot again later.
/// That's a known asymmetry of the `extra_fds` feature: callers asking for
/// an arbitrary high fd get the slot they asked for, but the table's
/// next-fd accounting can collide with it later. The contract author
/// owns picking non-conflicting numbers.
pub fn populateFdTable(setup: ParsedSetup, alloc: state_mod.Allocator) !void {
    const root = try paths.rootNode(alloc);
    const fd_table = &state_mod.current().fd_table;

    // Stdio: alloc returns 0, 1, 2 in order from the LIFO. The design
    // specifies stdio at fixed positions; the table's init order matches.
    const stdio_paths = [_][]const u8{ setup.stdin_path, setup.stdout_path, setup.stderr_path };
    for (stdio_paths) |path| {
        const node = (try vfs.resolve(root, path)).node;
        _ = fd_table.alloc(.{
            .node = node,
            .offset = 0,
            .rights_base = std.math.maxInt(u64),
            .rights_inheriting = std.math.maxInt(u64),
            .fdflags = 0,
            .preopen_path = null,
        }) orelse return error.FdTableFull;
    }

    // Preopens: each gets the next sequential fd starting at 3. Path bytes
    // are duped so `fd_prestat_dir_name` can return them after the parsed
    // setup goes out of scope.
    for (setup.preopens) |path| {
        const node = (try vfs.resolve(root, path)).node;
        const path_copy = codec.dupeBytes(alloc, path);
        _ = fd_table.alloc(.{
            .node = node,
            .offset = 0,
            .rights_base = std.math.maxInt(u64),
            .rights_inheriting = std.math.maxInt(u64),
            .fdflags = 0,
            .preopen_path = path_copy,
        }) orelse return error.FdTableFull;
    }

    // Extra fds: direct-write into the requested slot. Out-of-range jumps
    // surface as a typed error instead of trapping.
    for (setup.extra_fds) |extra| {
        if (extra.fd >= vfs.FdTable.MAX_FDS) return error.FdTableFull;
        const node = (try vfs.resolve(root, extra.path)).node;
        fd_table.entries[extra.fd] = .{
            .node = node,
            .offset = 0,
            .rights_base = std.math.maxInt(u64),
            .rights_inheriting = std.math.maxInt(u64),
            .fdflags = 0,
            .preopen_path = null,
        };
    }
}

// -- auto-close pass ------------------------------------------------------

/// Walk every FD slot at program exit and close any still-open node. The
/// design says: "If the program exits with an open FD, the shim closes it
/// automatically before returning to scaffold." Errors from `close` are
/// dropped because the program has already exited and we have no recourse;
/// every node implementation that has cleanup work (RecordAccumulator,
/// OutputLeaf) does its own one-shot guard so a double-close is benign.
pub fn autoCloseAll() void {
    const fd_table = &state_mod.current().fd_table;
    var i: u32 = 0;
    while (i < vfs.FdTable.MAX_FDS) : (i += 1) {
        if (fd_table.entries[i]) |entry| {
            entry.node.vtable.close(entry.node);
            fd_table.entries[i] = null;
        }
    }
}

// -- tests ----------------------------------------------------------------
//
// `read`, `populateFdTable`, and `autoCloseAll` all bottom out in
// `env.contractMetadata` / `paths.rootNode` / live state. Those exercises
// belong to the Phase E contract-trace snapshot suite. Native tests cover
// the JSON-shaped logic via `parseSetupJson`.

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

test "parseSetupJson returns defaults for empty object" {
    var buf: [2048]u8 = undefined;
    var arena: TestArena = .{ .buf = &buf };

    const got = try parseSetupJson("{}", arena.allocator());
    try testing.expectEqual(@as(usize, 1), got.argv.len);
    try testing.expectEqualStrings("program", got.argv[0]);
    try testing.expectEqual(@as(usize, 0), got.env.len);
    try testing.expectEqualStrings("/", got.cwd);
    try testing.expectEqual(@as(usize, 4), got.preopens.len);
    try testing.expectEqualStrings("/in", got.preopens[0]);
    try testing.expectEqualStrings("/out", got.preopens[1]);
    try testing.expectEqualStrings("/scratch", got.preopens[2]);
    try testing.expectEqualStrings("/dev", got.preopens[3]);
    try testing.expectEqualStrings("/dev/null", got.stdin_path);
    try testing.expectEqualStrings("/out/debug", got.stdout_path);
    try testing.expectEqualStrings("/out/debug", got.stderr_path);
    try testing.expectEqual(@as(usize, 0), got.extra_fds.len);
}

test "parseSetupJson honours per-field overrides" {
    var buf: [2048]u8 = undefined;
    var arena: TestArena = .{ .buf = &buf };

    const input = "{\"argv\":[\"a\",\"b\"],\"cwd\":\"/scratch\"}";
    const got = try parseSetupJson(input, arena.allocator());

    try testing.expectEqual(@as(usize, 2), got.argv.len);
    try testing.expectEqualStrings("a", got.argv[0]);
    try testing.expectEqualStrings("b", got.argv[1]);
    try testing.expectEqualStrings("/scratch", got.cwd);
    // Unmodified fields fall back to defaults.
    try testing.expectEqualStrings("/dev/null", got.stdin_path);
    try testing.expectEqual(@as(usize, 4), got.preopens.len);
}

test "parseSetupJson parses env, preopens, stdio, extra_fds together" {
    var buf: [4096]u8 = undefined;
    var arena: TestArena = .{ .buf = &buf };

    const input =
        "{\"argv\":[\"asc\"]," ++
        "\"env\":{\"K\":\"V\",\"PATH\":\"/usr/bin\"}," ++
        "\"cwd\":\"/scratch\"," ++
        "\"preopens\":[\"/in\",\"/scratch\"]," ++
        "\"stdin\":\"/dev/zero\"," ++
        "\"stdout\":\"/out/debug\"," ++
        "\"stderr\":\"/out/debug\"," ++
        "\"extra_fds\":{\"7\":\"/dev/random\"}}";
    const got = try parseSetupJson(input, arena.allocator());

    try testing.expectEqual(@as(usize, 1), got.argv.len);
    try testing.expectEqualStrings("asc", got.argv[0]);

    try testing.expectEqual(@as(usize, 2), got.env.len);
    try testing.expectEqualStrings("K", got.env[0].key);
    try testing.expectEqualStrings("V", got.env[0].val);
    try testing.expectEqualStrings("PATH", got.env[1].key);
    try testing.expectEqualStrings("/usr/bin", got.env[1].val);

    try testing.expectEqualStrings("/scratch", got.cwd);
    try testing.expectEqual(@as(usize, 2), got.preopens.len);
    try testing.expectEqualStrings("/in", got.preopens[0]);
    try testing.expectEqualStrings("/scratch", got.preopens[1]);

    try testing.expectEqualStrings("/dev/zero", got.stdin_path);
    try testing.expectEqualStrings("/out/debug", got.stdout_path);
    try testing.expectEqualStrings("/out/debug", got.stderr_path);

    try testing.expectEqual(@as(usize, 1), got.extra_fds.len);
    try testing.expectEqual(@as(u32, 7), got.extra_fds[0].fd);
    try testing.expectEqualStrings("/dev/random", got.extra_fds[0].path);
}

test "parseSetupJson silently ignores unknown top-level keys" {
    var buf: [1024]u8 = undefined;
    var arena: TestArena = .{ .buf = &buf };

    const input = "{\"future_key\":\"junk\",\"cwd\":\"/scratch\"}";
    const got = try parseSetupJson(input, arena.allocator());
    try testing.expectEqualStrings("/scratch", got.cwd);
    try testing.expectEqualStrings("program", got.argv[0]);
}

test "parseSetupJson rejects non-numeric extra_fds key" {
    var buf: [1024]u8 = undefined;
    var arena: TestArena = .{ .buf = &buf };

    const input = "{\"extra_fds\":{\"oops\":\"/dev/null\"}}";
    try testing.expectError(
        error.InvalidExtraFdKey,
        parseSetupJson(input, arena.allocator()),
    );
}

test "parseSetupJson rejects wrong-shape argv" {
    var buf: [1024]u8 = undefined;
    var arena: TestArena = .{ .buf = &buf };

    const input = "{\"argv\":\"not-an-array\"}";
    try testing.expectError(
        error.InvalidShape,
        parseSetupJson(input, arena.allocator()),
    );
}

test "parseSetupJson rejects non-string env value" {
    var buf: [1024]u8 = undefined;
    var arena: TestArena = .{ .buf = &buf };

    const input = "{\"env\":{\"K\":true}}";
    try testing.expectError(
        error.InvalidShape,
        parseSetupJson(input, arena.allocator()),
    );
}

test "parseSetupJson rejects non-object top level" {
    var buf: [1024]u8 = undefined;
    var arena: TestArena = .{ .buf = &buf };

    try testing.expectError(
        error.InvalidShape,
        parseSetupJson("[]", arena.allocator()),
    );
}

test "parseSetupJson surfaces malformed JSON as BadJson" {
    var buf: [1024]u8 = undefined;
    var arena: TestArena = .{ .buf = &buf };

    try testing.expectError(
        error.BadJson,
        parseSetupJson("{not json", arena.allocator()),
    );
}
