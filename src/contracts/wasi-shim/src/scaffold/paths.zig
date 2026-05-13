// Maps the shim's virtual filesystem layout (`/in`, `/out`, `/scratch`,
// `/dev`) onto `scaffold_env` operations. setup.zig calls `rootNode(alloc)`
// to obtain the per-run root and then walks user-supplied preopen paths via
// `vfs.resolve`. The pure path-encoding + wire-format helpers live in
// `paths_codec.zig`; this file glues them to env.zig so the leaves can call
// scaffold (and is therefore wasm-only -- the native test harness pulls in
// `paths_codec.zig` exclusively).
//
// Lifetime
// --------
// All node storage is carved from the per-run bump allocator passed to
// `rootNode`. Module-level state is one nullable cached root pointer plus a
// fixed BSS debug buffer; `reset()` zeros the cache so the next run rebinds
// against fresh state. main.zig must call `reset()` before `state.init` at
// the top of every `run`.
//
// Dual file-and-directory pattern
// -------------------------------
// The trailing portion of `/in/fetch/<hash>/<params>/<key>` and
// `/out/record/<key>` may span multiple `/`-separated segments because
// record keys are bytes that may contain literal slashes (see "Record-key
// paths" in the design). We model this without distinguishing a
// "key-builder" from a "leaf" up front: every node beyond `<params>` (or
// beyond `record`) implements **both** `lookup` (which mints a child node
// with the segment appended to the accumulated key) and
// `read`/`write`/`close` (which act on the accumulated key as a complete
// key). `vfs.resolve` walks segments via `lookup` and stops at the deepest
// segment; whatever node it lands on is what `path_open` then opens. This
// is unusual -- POSIX nodes are either directory or file, not both -- but
// it falls out of WASI's design and the alternative ("decide direction up
// front") would require an oracle the shim doesn't have.
//
// Trade-off: `stat` on a key-accumulator node always reports REGULAR_FILE
// because that's the dominant `path_open` call shape. A program that runs
// `path_filestat_get` on an intermediate path before `path_open` will see
// REGULAR_FILE; a program that then opens with `O_DIRECTORY` gets `NOTDIR`
// from the abi layer. We accept the asymmetry because the WASI contract
// for "open a key" matches "open a file" overwhelmingly more often than
// "open a directory."
//
// `/out/debug` routing
// --------------------
// Writes are line-buffered in a fixed BSS slot and flushed to
// `scaffold_env.debug` (and from there to `ctx.logger('contract').debug`)
// on each `\n`. `autoCloseAll` flushes the trailing partial line via the
// `DebugNode.close` vtable entry. The host treats the bytes as UTF-8.

const std = @import("std");

const vfs = @import("../vfs/vfs.zig");
const env = @import("env.zig");
const memfs = @import("../vfs/memfs.zig");
const devfs = @import("../vfs/devfs.zig");
const input_node = @import("../vfs/input_node.zig");
const state_mod = @import("../state.zig");
const codec = @import("paths_codec.zig");

// Re-export the codec helpers so callers don't have to know about the split.
pub const decodeContractHash = codec.decodeContractHash;
pub const decodeParams = codec.decodeParams;
pub const decodeRecordKey = codec.decodeRecordKey;
pub const decodeAmount = codec.decodeAmount;
pub const RECORD_CONTRACT_HASH = codec.RECORD_CONTRACT_HASH;

/// `/out/debug` writes now route to `scaffold_env.debug`; the buffer is
/// purely a line-flush staging slot. Kept as a constant so older test
/// scaffolding that probed the previous routing still compiles.
pub const debug_routing_is_buffer: bool = false;

// -- public surface -------------------------------------------------------

/// Per-run lazy-singleton cache. `null` between runs (after `reset`).
var root_node: ?*vfs.Node = null;

/// Reset the cached root and any per-run BSS (notably the debug line buffer)
/// so the next run starts clean. Must be called from `main.run` before
/// `state.init`.
pub fn reset() void {
    root_node = null;
    debug_pos = 0;
}

/// Returns the singleton root node for this run. Lazily built on first
/// call; every subsequent call within the same run returns the same
/// pointer. `alloc` is used only on the first call.
pub fn rootNode(alloc: state_mod.Allocator) !*vfs.Node {
    if (root_node) |r| return r;
    const built = try buildRoot(alloc);
    root_node = built;
    return built;
}

// -- root construction ---------------------------------------------------

/// Synthetic-directory node for the root and the static layer of `/in`,
/// `/out`. Children are a fixed slice in arena memory; lookup is O(N) over
/// a small N (≤7).
const StaticDir = struct {
    node: vfs.Node,
    children: []const StaticChild,

    const vtable: vfs.NodeVTable = .{
        .stat = stat,
        .read = read,
        .write = write,
        .close = noopClose,
        .readdir = readdir,
        .lookup = lookup,
    };

    fn stat(_: *vfs.Node) vfs.VfsError!vfs.Stat {
        return .{ .filetype = .DIRECTORY, .size = 0 };
    }
    fn read(_: *vfs.Node, _: u64, _: []u8) vfs.VfsError!usize {
        return vfs.VfsError.IsADirectory;
    }
    fn write(_: *vfs.Node, _: u64, _: []const u8) vfs.VfsError!usize {
        return vfs.VfsError.IsADirectory;
    }
    fn lookup(self_node: *vfs.Node, name: []const u8) vfs.VfsError!*vfs.Node {
        const self: *StaticDir = @fieldParentPtr("node", self_node);
        for (self.children) |c| {
            if (std.mem.eql(u8, c.name, name)) return c.node;
        }
        return vfs.VfsError.NotFound;
    }
    fn readdir(self_node: *vfs.Node, cookie: u64, out: []vfs.DirEntry) vfs.VfsError!usize {
        const self: *StaticDir = @fieldParentPtr("node", self_node);
        if (cookie >= self.children.len) return 0;
        const start: usize = @intCast(cookie);
        const remaining = self.children.len - start;
        const n = @min(remaining, out.len);
        for (out[0..n], self.children[start .. start + n]) |*entry, c| {
            // Probe the child's stat for the right filetype; static
            // directories can mix dirs (e.g. `/in/fetch`) and files (e.g.
            // `/in/mode`), so we can't hardcode here. A failed stat falls
            // back to UNKNOWN rather than failing the whole readdir.
            const s = c.node.vtable.stat(c.node) catch vfs.Stat{
                .filetype = .UNKNOWN,
                .size = 0,
            };
            entry.* = .{ .name = c.name, .filetype = s.filetype };
        }
        return n;
    }
};

const StaticChild = struct { name: []const u8, node: *vfs.Node };

fn noopClose(_: *vfs.Node) void {}

fn allocDir(alloc: state_mod.Allocator, children: []const StaticChild) !*vfs.Node {
    const dir_bytes = alloc.alloc(alloc.ctx, @sizeOf(StaticDir));
    const dir: *StaticDir = @ptrCast(@alignCast(dir_bytes.ptr));

    const children_bytes = alloc.alloc(
        alloc.ctx,
        children.len * @sizeOf(StaticChild),
    );
    const children_copy: []StaticChild = @as(
        [*]StaticChild,
        @ptrCast(@alignCast(children_bytes.ptr)),
    )[0..children.len];
    @memcpy(children_copy, children);

    dir.* = .{
        .node = .{ .vtable = &StaticDir.vtable },
        .children = children_copy,
    };
    return &dir.node;
}

fn buildRoot(alloc: state_mod.Allocator) !*vfs.Node {
    // /in leaves -- 4 fixed input_nodes for the immediate scalar inputs.
    const mode_node = try allocInputProducer(alloc, makeMode);
    const ts_node = try allocInputProducer(alloc, makeTimestamp);
    const ch_node = try allocInputProducer(alloc, makeContractHash);
    const params_node = try allocInputProducer(alloc, makeParams);

    // /in dynamic dirs.
    const cm_root = try allocVerifierBranch(alloc, .contract_metadata);
    const body_root = try allocVerifierBranch(alloc, .body);
    const fetch_root = try allocVerifierBranch(alloc, .fetch);

    const in_dir = try allocDir(alloc, &[_]StaticChild{
        .{ .name = "mode", .node = mode_node },
        .{ .name = "timestamp", .node = ts_node },
        .{ .name = "contract_hash", .node = ch_node },
        .{ .name = "params", .node = params_node },
        .{ .name = "contract_metadata", .node = cm_root },
        .{ .name = "body", .node = body_root },
        .{ .name = "fetch", .node = fetch_root },
    });

    // /out children.
    const record_root = try allocOutRoot(alloc, .record);
    const output_root = try allocOutRoot(alloc, .output);
    const debug_node = try allocDebugNode(alloc);

    const out_dir = try allocDir(alloc, &[_]StaticChild{
        .{ .name = "record", .node = record_root },
        .{ .name = "output", .node = output_root },
        .{ .name = "debug", .node = debug_node },
    });

    // /scratch -- empty memfs root. The MemfsArena buffer comes from the
    // per-run bump allocator. 64 KiB is a starting guess; programs that
    // need more can be bumped up here without protocol impact.
    const SCRATCH_ARENA_BYTES: usize = 64 * 1024;
    const scratch_buf = alloc.alloc(alloc.ctx, SCRATCH_ARENA_BYTES);
    const scratch_arena_bytes = alloc.alloc(alloc.ctx, @sizeOf(memfs.MemfsArena));
    const scratch_arena: *memfs.MemfsArena = @ptrCast(@alignCast(scratch_arena_bytes.ptr));
    scratch_arena.* = memfs.MemfsArena.init(scratch_buf);
    const scratch_dir = memfs.makeDir(scratch_arena, "scratch") orelse
        return error.OutOfMemory;

    return try allocDir(alloc, &[_]StaticChild{
        .{ .name = "in", .node = in_dir },
        .{ .name = "out", .node = out_dir },
        .{ .name = "scratch", .node = scratch_dir },
        .{ .name = "dev", .node = devfs.dev_dir },
    });
}

// -- /in scalar input nodes ---------------------------------------------

const ProducerFactory = *const fn () []const u8;

const ProducerCtx = struct {
    factory: ProducerFactory,
};

fn producerThunk(ctx: ?*anyopaque) ?[]const u8 {
    const c: *ProducerCtx = @ptrCast(@alignCast(ctx.?));
    return c.factory();
}

fn allocInputProducer(alloc: state_mod.Allocator, factory: ProducerFactory) !*vfs.Node {
    const ctx_bytes = alloc.alloc(alloc.ctx, @sizeOf(ProducerCtx));
    const ctx: *ProducerCtx = @ptrCast(@alignCast(ctx_bytes.ptr));
    ctx.* = .{ .factory = factory };

    const node_bytes = alloc.alloc(alloc.ctx, @sizeOf(input_node.InputNode));
    const node: *input_node.InputNode = @ptrCast(@alignCast(node_bytes.ptr));
    input_node.init(node, producerThunk, ctx);
    return &node.node;
}

// /in/mode: 1 byte (0=generate, 1=verify). Cached in BSS so the slice
// outlives the call (bump arena would also work; BSS is fewer moving parts).
var mode_byte: [1]u8 = .{0};

fn makeMode() []const u8 {
    mode_byte[0] = env.mode();
    return mode_byte[0..1];
}

var ts_bytes: [8]u8 = undefined;

fn makeTimestamp() []const u8 {
    std.mem.writeInt(u64, &ts_bytes, env.timestamp(), .little);
    return ts_bytes[0..8];
}

fn makeContractHash() []const u8 {
    // Pull straight from state, which has the bytes already copied into
    // shim memory by `state.init`. Avoids the env.contractHash() copy.
    return state_mod.current().contract_hash[0..];
}

fn makeParams() []const u8 {
    // env.params() returns a slice into the shim's bump arena. The arena
    // only grows, so the slice stays valid for the duration of the run.
    return env.params();
}

// -- /in/{contract_metadata,body,fetch} dynamic branches ----------------

const VerifierBranchKind = enum { contract_metadata, body, fetch };

const VerifierBranchRoot = struct {
    node: vfs.Node,
    alloc: state_mod.Allocator,
    kind: VerifierBranchKind,

    const vtable: vfs.NodeVTable = .{
        .stat = stat,
        .read = readErr,
        .write = writeErr,
        .close = noopClose,
        // See design "Static directory listings": dynamic /in/ dirs return
        // ENOTSUP on readdir (faking enumeration would mislead programs).
        .readdir = null,
        .lookup = lookup,
    };

    fn stat(_: *vfs.Node) vfs.VfsError!vfs.Stat {
        return .{ .filetype = .DIRECTORY, .size = 0 };
    }
    fn readErr(_: *vfs.Node, _: u64, _: []u8) vfs.VfsError!usize {
        return vfs.VfsError.IsADirectory;
    }
    fn writeErr(_: *vfs.Node, _: u64, _: []const u8) vfs.VfsError!usize {
        return vfs.VfsError.ReadOnly;
    }
    fn lookup(self_node: *vfs.Node, name: []const u8) vfs.VfsError!*vfs.Node {
        const self: *VerifierBranchRoot = @fieldParentPtr("node", self_node);
        const hash = decodeContractHash(name) orelse return vfs.VfsError.InvalidArgument;
        return allocParamsLevel(self.alloc, self.kind, hash) catch
            vfs.VfsError.OutOfSpace;
    }
};

fn allocVerifierBranch(
    alloc: state_mod.Allocator,
    kind: VerifierBranchKind,
) !*vfs.Node {
    const bytes = alloc.alloc(alloc.ctx, @sizeOf(VerifierBranchRoot));
    const node: *VerifierBranchRoot = @ptrCast(@alignCast(bytes.ptr));
    node.* = .{
        .node = .{ .vtable = &VerifierBranchRoot.vtable },
        .alloc = alloc,
        .kind = kind,
    };
    return &node.node;
}

const ParamsLevel = struct {
    node: vfs.Node,
    alloc: state_mod.Allocator,
    kind: VerifierBranchKind,
    contract_hash: [32]u8,

    const vtable: vfs.NodeVTable = .{
        .stat = stat,
        .read = readErr,
        .write = writeErr,
        .close = noopClose,
        .readdir = null,
        .lookup = lookup,
    };

    fn stat(_: *vfs.Node) vfs.VfsError!vfs.Stat {
        return .{ .filetype = .DIRECTORY, .size = 0 };
    }
    fn readErr(_: *vfs.Node, _: u64, _: []u8) vfs.VfsError!usize {
        return vfs.VfsError.IsADirectory;
    }
    fn writeErr(_: *vfs.Node, _: u64, _: []const u8) vfs.VfsError!usize {
        return vfs.VfsError.ReadOnly;
    }
    fn lookup(self_node: *vfs.Node, name: []const u8) vfs.VfsError!*vfs.Node {
        const self: *ParamsLevel = @fieldParentPtr("node", self_node);
        const params = decodeParams(name, self.alloc) orelse
            return vfs.VfsError.InvalidArgument;
        return switch (self.kind) {
            .contract_metadata => allocVerifierLeaf(
                self.alloc,
                .contract_metadata,
                self.contract_hash,
                params,
            ) catch vfs.VfsError.OutOfSpace,
            .body => allocVerifierLeaf(
                self.alloc,
                .body,
                self.contract_hash,
                params,
            ) catch vfs.VfsError.OutOfSpace,
            .fetch => allocFetchAccumulator(
                self.alloc,
                self.contract_hash,
                params,
                &[_][]const u8{},
            ) catch vfs.VfsError.OutOfSpace,
        };
    }
};

fn allocParamsLevel(
    alloc: state_mod.Allocator,
    kind: VerifierBranchKind,
    contract_hash: [32]u8,
) !*vfs.Node {
    const bytes = alloc.alloc(alloc.ctx, @sizeOf(ParamsLevel));
    const node: *ParamsLevel = @ptrCast(@alignCast(bytes.ptr));
    node.* = .{
        .node = .{ .vtable = &ParamsLevel.vtable },
        .alloc = alloc,
        .kind = kind,
        .contract_hash = contract_hash,
    };
    return &node.node;
}

// -- Verifier leaves: /in/contract_metadata/.../{params}, /in/body/... --

const VerifierLeafKind = enum { contract_metadata, body };

const VerifierLeaf = struct {
    node: vfs.Node,
    alloc: state_mod.Allocator,
    kind: VerifierLeafKind,
    contract_hash: [32]u8,
    params: []const u8,
    cached_body: ?[]const u8,

    const vtable: vfs.NodeVTable = .{
        .stat = stat,
        .read = read,
        .write = writeErr,
        .close = noopClose,
        .readdir = null,
        .lookup = null,
    };

    fn stat(self_node: *vfs.Node) vfs.VfsError!vfs.Stat {
        const self: *VerifierLeaf = @fieldParentPtr("node", self_node);
        const size: u64 = if (self.cached_body) |b| b.len else 0;
        return .{ .filetype = .REGULAR_FILE, .size = size };
    }

    fn read(self_node: *vfs.Node, offset: u64, out: []u8) vfs.VfsError!usize {
        const self: *VerifierLeaf = @fieldParentPtr("node", self_node);
        if (self.cached_body == null) {
            self.cached_body = fetchBody(self) catch |err| return err;
        }
        const bytes = self.cached_body.?;
        if (offset >= bytes.len) return 0;
        const start: usize = @intCast(offset);
        const remaining = bytes.len - start;
        const n = @min(remaining, out.len);
        @memcpy(out[0..n], bytes[start..][0..n]);
        return n;
    }

    fn writeErr(_: *vfs.Node, _: u64, _: []const u8) vfs.VfsError!usize {
        return vfs.VfsError.ReadOnly;
    }
};

fn allocVerifierLeaf(
    alloc: state_mod.Allocator,
    kind: VerifierLeafKind,
    contract_hash: [32]u8,
    params: []const u8,
) !*vfs.Node {
    const bytes = alloc.alloc(alloc.ctx, @sizeOf(VerifierLeaf));
    const node: *VerifierLeaf = @ptrCast(@alignCast(bytes.ptr));
    node.* = .{
        .node = .{ .vtable = &VerifierLeaf.vtable },
        .alloc = alloc,
        .kind = kind,
        .contract_hash = contract_hash,
        .params = params,
        .cached_body = null,
    };
    return &node.node;
}

fn fetchBody(self: *VerifierLeaf) vfs.VfsError![]const u8 {
    const verifier = codec.encodeVerifier(self.alloc, self.contract_hash, self.params);
    const reply = switch (self.kind) {
        .contract_metadata => env.contractMetadata(verifier),
        .body => env.requestBody(verifier),
    };
    // The host bridge converts a missing-record `ContractRejection` into an
    // empty reply, which `unpackBody` rejects -- programs reading an absent
    // metadata key see `InvalidArgument`. The trade-off vs surfacing an
    // empty file is intentional: the design doesn't distinguish "absent"
    // from "present but malformed", so we only fall back to defaults
    // inside `setup.read`, where the design explicitly says we should.
    return codec.unpackBody(reply) catch vfs.VfsError.InvalidArgument;
}

// -- /in/fetch dual file/directory --------------------------------------

const FetchAccumulator = struct {
    node: vfs.Node,
    alloc: state_mod.Allocator,
    contract_hash: [32]u8,
    params: []const u8,
    /// Path segments past `<params>`. Each entry is owned by the bump arena
    /// (already duped at lookup time).
    segments: []const []const u8,
    cached_body: ?[]const u8,

    const vtable: vfs.NodeVTable = .{
        .stat = stat,
        .read = read,
        .write = writeErr,
        .close = noopClose,
        .readdir = null,
        .lookup = lookup,
    };

    fn stat(self_node: *vfs.Node) vfs.VfsError!vfs.Stat {
        const self: *FetchAccumulator = @fieldParentPtr("node", self_node);
        // Dual file/directory: report REGULAR_FILE because the dominant call
        // shape is `path_open` for read. See the file header for trade-off.
        const size: u64 = if (self.cached_body) |b| b.len else 0;
        return .{ .filetype = .REGULAR_FILE, .size = size };
    }

    fn read(self_node: *vfs.Node, offset: u64, out: []u8) vfs.VfsError!usize {
        const self: *FetchAccumulator = @fieldParentPtr("node", self_node);
        if (self.cached_body == null) {
            const verifier = codec.encodeVerifier(
                self.alloc,
                self.contract_hash,
                self.params,
            );
            const key = decodeRecordKey(self.segments, self.alloc) orelse
                return vfs.VfsError.InvalidArgument;
            self.cached_body = env.fetch(verifier, key);
        }
        const bytes = self.cached_body.?;
        if (offset >= bytes.len) return 0;
        const start: usize = @intCast(offset);
        const remaining = bytes.len - start;
        const n = @min(remaining, out.len);
        @memcpy(out[0..n], bytes[start..][0..n]);
        return n;
    }

    fn writeErr(_: *vfs.Node, _: u64, _: []const u8) vfs.VfsError!usize {
        return vfs.VfsError.ReadOnly;
    }

    fn lookup(self_node: *vfs.Node, name: []const u8) vfs.VfsError!*vfs.Node {
        const self: *FetchAccumulator = @fieldParentPtr("node", self_node);
        const new_segments = codec.appendSegment(self.alloc, self.segments, name);
        return allocFetchAccumulator(
            self.alloc,
            self.contract_hash,
            self.params,
            new_segments,
        ) catch vfs.VfsError.OutOfSpace;
    }
};

fn allocFetchAccumulator(
    alloc: state_mod.Allocator,
    contract_hash: [32]u8,
    params: []const u8,
    segments: []const []const u8,
) !*vfs.Node {
    const bytes = alloc.alloc(alloc.ctx, @sizeOf(FetchAccumulator));
    const node: *FetchAccumulator = @ptrCast(@alignCast(bytes.ptr));
    node.* = .{
        .node = .{ .vtable = &FetchAccumulator.vtable },
        .alloc = alloc,
        .contract_hash = contract_hash,
        .params = params,
        .segments = segments,
        .cached_body = null,
    };
    return &node.node;
}

// -- /out (record / output / debug) -------------------------------------

const OutRootKind = enum { record, output };

/// First-level node under `/out/record` or `/out/output`.
/// - `/out/record`: lookup(name) starts the record-key accumulator with
///   `name` as the first segment.
/// - `/out/output`: lookup(name) expects a `0x`-prefixed hex hash and
///   returns an OutputParamsLevel bound to it.
const OutRoot = struct {
    node: vfs.Node,
    alloc: state_mod.Allocator,
    kind: OutRootKind,

    const vtable: vfs.NodeVTable = .{
        .stat = stat,
        .read = readErr,
        .write = writeErr,
        .close = noopClose,
        .readdir = null,
        .lookup = lookup,
    };

    fn stat(_: *vfs.Node) vfs.VfsError!vfs.Stat {
        return .{ .filetype = .DIRECTORY, .size = 0 };
    }
    fn readErr(_: *vfs.Node, _: u64, _: []u8) vfs.VfsError!usize {
        return vfs.VfsError.IsADirectory;
    }
    fn writeErr(_: *vfs.Node, _: u64, _: []const u8) vfs.VfsError!usize {
        return vfs.VfsError.IsADirectory;
    }
    fn lookup(self_node: *vfs.Node, name: []const u8) vfs.VfsError!*vfs.Node {
        const self: *OutRoot = @fieldParentPtr("node", self_node);
        switch (self.kind) {
            .record => {
                // Seed the accumulator with `name` as segment 0; subsequent
                // lookups append more segments via RecordAccumulator.lookup.
                const segs = codec.appendSegment(self.alloc, &[_][]const u8{}, name);
                return allocRecordAccumulator(self.alloc, segs) catch
                    vfs.VfsError.OutOfSpace;
            },
            .output => {
                const hash = decodeContractHash(name) orelse
                    return vfs.VfsError.InvalidArgument;
                return allocOutputParamsLevel(self.alloc, hash) catch
                    vfs.VfsError.OutOfSpace;
            },
        }
    }
};

fn allocOutRoot(alloc: state_mod.Allocator, kind: OutRootKind) !*vfs.Node {
    const bytes = alloc.alloc(alloc.ctx, @sizeOf(OutRoot));
    const node: *OutRoot = @ptrCast(@alignCast(bytes.ptr));
    node.* = .{
        .node = .{ .vtable = &OutRoot.vtable },
        .alloc = alloc,
        .kind = kind,
    };
    return &node.node;
}

// -- /out/record dual file/directory ------------------------------------

/// Per-fd accumulator for a `/out/record/<key...>` write. Each `lookup`
/// allocates a fresh node with one more segment, so `path_open` always sees
/// a unique node -- per design ("Reopening the same path is allowed; each
/// cycle emits independently"). `close` flushes via emit_output.
const RecordAccumulator = struct {
    node: vfs.Node,
    alloc: state_mod.Allocator,
    segments: []const []const u8,
    bytes: []u8,
    capacity: usize,
    len: usize,
    closed: bool,

    const vtable: vfs.NodeVTable = .{
        .stat = stat,
        .read = readErr,
        .write = write,
        .close = close,
        .readdir = null,
        .lookup = lookup,
    };

    fn stat(self_node: *vfs.Node) vfs.VfsError!vfs.Stat {
        const self: *RecordAccumulator = @fieldParentPtr("node", self_node);
        return .{ .filetype = .REGULAR_FILE, .size = self.len };
    }
    fn readErr(_: *vfs.Node, _: u64, _: []u8) vfs.VfsError!usize {
        // /out is write-only.
        return vfs.VfsError.NotSupported;
    }
    fn write(self_node: *vfs.Node, offset: u64, src: []const u8) vfs.VfsError!usize {
        const self: *RecordAccumulator = @fieldParentPtr("node", self_node);
        if (offset > self.len) return vfs.VfsError.InvalidArgument;
        const start: usize = @intCast(offset);
        const end = start + src.len;
        if (end > self.capacity) {
            const new_cap = growCapacity(self.capacity, end);
            const new_buf = self.alloc.alloc(self.alloc.ctx, new_cap);
            @memcpy(new_buf[0..self.len], self.bytes[0..self.len]);
            self.bytes = new_buf;
            self.capacity = new_cap;
        }
        @memcpy(self.bytes[start..end], src);
        if (end > self.len) self.len = end;
        return src.len;
    }
    fn close(self_node: *vfs.Node) void {
        const self: *RecordAccumulator = @fieldParentPtr("node", self_node);
        if (self.closed) return;
        self.closed = true;
        const key = decodeRecordKey(self.segments, self.alloc) orelse {
            // Closing a buffer whose key didn't decode is a contract bug --
            // path_open would have failed earlier on a malformed segment.
            // The only failure mode here is OutOfSpace concatenating the
            // key, which is fatal -- surface via env.reject rather than
            // dropping the write (silent loss is the worst outcome for a
            // deterministic shim).
            env.reject("WASI shim: /out/record key encode failed at close");
        };
        const verifier = codec.encodeVerifier(self.alloc, RECORD_CONTRACT_HASH, key);
        const out = codec.encodeOutput(self.alloc, verifier, 0, self.bytes[0..self.len]);
        env.emitOutput(out);
    }
    fn lookup(self_node: *vfs.Node, name: []const u8) vfs.VfsError!*vfs.Node {
        const self: *RecordAccumulator = @fieldParentPtr("node", self_node);
        const new_segments = codec.appendSegment(self.alloc, self.segments, name);
        return allocRecordAccumulator(self.alloc, new_segments) catch
            vfs.VfsError.OutOfSpace;
    }
};

fn allocRecordAccumulator(
    alloc: state_mod.Allocator,
    segments: []const []const u8,
) !*vfs.Node {
    const bytes = alloc.alloc(alloc.ctx, @sizeOf(RecordAccumulator));
    const node: *RecordAccumulator = @ptrCast(@alignCast(bytes.ptr));
    node.* = .{
        .node = .{ .vtable = &RecordAccumulator.vtable },
        .alloc = alloc,
        .segments = segments,
        .bytes = &.{},
        .capacity = 0,
        .len = 0,
        .closed = false,
    };
    return &node.node;
}

// -- /out/output ---------------------------------------------------------

const OutputParamsLevel = struct {
    node: vfs.Node,
    alloc: state_mod.Allocator,
    contract_hash: [32]u8,

    const vtable: vfs.NodeVTable = .{
        .stat = stat,
        .read = readErr,
        .write = writeErr,
        .close = noopClose,
        .readdir = null,
        .lookup = lookup,
    };

    fn stat(_: *vfs.Node) vfs.VfsError!vfs.Stat {
        return .{ .filetype = .DIRECTORY, .size = 0 };
    }
    fn readErr(_: *vfs.Node, _: u64, _: []u8) vfs.VfsError!usize {
        return vfs.VfsError.IsADirectory;
    }
    fn writeErr(_: *vfs.Node, _: u64, _: []const u8) vfs.VfsError!usize {
        return vfs.VfsError.IsADirectory;
    }
    fn lookup(self_node: *vfs.Node, name: []const u8) vfs.VfsError!*vfs.Node {
        const self: *OutputParamsLevel = @fieldParentPtr("node", self_node);
        const params = decodeParams(name, self.alloc) orelse
            return vfs.VfsError.InvalidArgument;
        return allocOutputAmountLevel(self.alloc, self.contract_hash, params) catch
            vfs.VfsError.OutOfSpace;
    }
};

fn allocOutputParamsLevel(
    alloc: state_mod.Allocator,
    contract_hash: [32]u8,
) !*vfs.Node {
    const bytes = alloc.alloc(alloc.ctx, @sizeOf(OutputParamsLevel));
    const node: *OutputParamsLevel = @ptrCast(@alignCast(bytes.ptr));
    node.* = .{
        .node = .{ .vtable = &OutputParamsLevel.vtable },
        .alloc = alloc,
        .contract_hash = contract_hash,
    };
    return &node.node;
}

const OutputAmountLevel = struct {
    node: vfs.Node,
    alloc: state_mod.Allocator,
    contract_hash: [32]u8,
    params: []const u8,

    const vtable: vfs.NodeVTable = .{
        .stat = stat,
        .read = readErr,
        .write = writeErr,
        .close = noopClose,
        .readdir = null,
        .lookup = lookup,
    };

    fn stat(_: *vfs.Node) vfs.VfsError!vfs.Stat {
        return .{ .filetype = .DIRECTORY, .size = 0 };
    }
    fn readErr(_: *vfs.Node, _: u64, _: []u8) vfs.VfsError!usize {
        return vfs.VfsError.IsADirectory;
    }
    fn writeErr(_: *vfs.Node, _: u64, _: []const u8) vfs.VfsError!usize {
        return vfs.VfsError.IsADirectory;
    }
    fn lookup(self_node: *vfs.Node, name: []const u8) vfs.VfsError!*vfs.Node {
        const self: *OutputAmountLevel = @fieldParentPtr("node", self_node);
        const amount = decodeAmount(name) orelse return vfs.VfsError.InvalidArgument;
        return allocOutputLeaf(
            self.alloc,
            self.contract_hash,
            self.params,
            amount,
        ) catch vfs.VfsError.OutOfSpace;
    }
};

fn allocOutputAmountLevel(
    alloc: state_mod.Allocator,
    contract_hash: [32]u8,
    params: []const u8,
) !*vfs.Node {
    const bytes = alloc.alloc(alloc.ctx, @sizeOf(OutputAmountLevel));
    const node: *OutputAmountLevel = @ptrCast(@alignCast(bytes.ptr));
    node.* = .{
        .node = .{ .vtable = &OutputAmountLevel.vtable },
        .alloc = alloc,
        .contract_hash = contract_hash,
        .params = params,
    };
    return &node.node;
}

/// Leaf for `/out/output/<hash>/<params>/<amount>`. Buffers writes; emits
/// on close. Amount is split into a `u64` low/high pair to dodge the 16-byte
/// alignment that an `i128` field would impose on the parent struct.
///
/// Even with the i128 split, `vfs.Node` (alignment 4 on wasm32) is narrower
/// than the surrounding struct (alignment 8 from the u64 amount halves), so
/// `@fieldParentPtr` in the vtable methods needs an `@alignCast` to recover
/// `*OutputLeaf` from `*vfs.Node`. Safe because every OutputLeaf is allocated
/// via `@alignCast` in `allocOutputLeaf`.
const OutputLeaf = struct {
    node: vfs.Node,
    alloc: state_mod.Allocator,
    contract_hash: [32]u8,
    params: []const u8,
    amount_lo: u64,
    amount_hi: u64,
    bytes: []u8,
    capacity: usize,
    len: usize,
    closed: bool,

    const vtable: vfs.NodeVTable = .{
        .stat = stat,
        .read = readErr,
        .write = write,
        .close = close,
        .readdir = null,
        .lookup = null,
    };

    fn amount(self: *const OutputLeaf) i128 {
        const u: u128 = (@as(u128, self.amount_hi) << 64) | @as(u128, self.amount_lo);
        return @bitCast(u);
    }

    fn stat(self_node: *vfs.Node) vfs.VfsError!vfs.Stat {
        const self: *OutputLeaf = @alignCast(@fieldParentPtr("node", self_node));
        return .{ .filetype = .REGULAR_FILE, .size = self.len };
    }
    fn readErr(_: *vfs.Node, _: u64, _: []u8) vfs.VfsError!usize {
        return vfs.VfsError.NotSupported;
    }
    fn write(self_node: *vfs.Node, offset: u64, src: []const u8) vfs.VfsError!usize {
        const self: *OutputLeaf = @alignCast(@fieldParentPtr("node", self_node));
        if (offset > self.len) return vfs.VfsError.InvalidArgument;
        const start: usize = @intCast(offset);
        const end = start + src.len;
        if (end > self.capacity) {
            const new_cap = growCapacity(self.capacity, end);
            const new_buf = self.alloc.alloc(self.alloc.ctx, new_cap);
            @memcpy(new_buf[0..self.len], self.bytes[0..self.len]);
            self.bytes = new_buf;
            self.capacity = new_cap;
        }
        @memcpy(self.bytes[start..end], src);
        if (end > self.len) self.len = end;
        return src.len;
    }
    fn close(self_node: *vfs.Node) void {
        const self: *OutputLeaf = @alignCast(@fieldParentPtr("node", self_node));
        if (self.closed) return;
        self.closed = true;
        const verifier = codec.encodeVerifier(self.alloc, self.contract_hash, self.params);
        const out = codec.encodeOutput(self.alloc, verifier, self.amount(), self.bytes[0..self.len]);
        env.emitOutput(out);
    }
};

fn allocOutputLeaf(
    alloc: state_mod.Allocator,
    contract_hash: [32]u8,
    params: []const u8,
    amount: i128,
) !*vfs.Node {
    const bytes = alloc.alloc(alloc.ctx, @sizeOf(OutputLeaf));
    const node: *OutputLeaf = @ptrCast(@alignCast(bytes.ptr));
    const u: u128 = @bitCast(amount);
    node.* = .{
        .node = .{ .vtable = &OutputLeaf.vtable },
        .alloc = alloc,
        .contract_hash = contract_hash,
        .params = params,
        .amount_lo = @truncate(u),
        .amount_hi = @truncate(u >> 64),
        .bytes = &.{},
        .capacity = 0,
        .len = 0,
        .closed = false,
    };
    return &node.node;
}

// -- /out/debug ---------------------------------------------------------

/// Line-buffer for `/out/debug`. Writes accumulate here; each `\n` flushes
/// the buffered prefix (without the newline) via `env.debug`. The trailing
/// partial line is flushed by `DebugNode.close`, which `autoCloseAll`
/// calls at program exit. The fixed cap matches the design's
/// "diagnostic-only" promise -- if a single line exceeds it, the buffer
/// flushes the prefix early and continues accumulating, so the line shows
/// up as multiple debug events rather than being silently truncated.
const DEBUG_BUFFER_BYTES: usize = 4096;
var debug_buffer: [DEBUG_BUFFER_BYTES]u8 = undefined;
var debug_pos: usize = 0;

/// Flush the current buffer (if non-empty) and reset.
fn flushDebug() void {
    if (debug_pos == 0) return;
    env.debug(debug_buffer[0..debug_pos]);
    debug_pos = 0;
}

/// Append `src` to the line buffer, flushing on each `\n` and whenever the
/// buffer fills. The newline itself is dropped: each flush is one logical
/// debug line, and `ctx.logger` already adds its own framing.
fn appendDebug(src: []const u8) void {
    var i: usize = 0;
    while (i < src.len) {
        // Find the next newline in the remaining input; everything before it
        // (plus any current buffered prefix) becomes one debug event.
        const nl_rel = std.mem.indexOfScalar(u8, src[i..], '\n');
        const chunk_end = if (nl_rel) |o| i + o else src.len;
        var j: usize = i;
        while (j < chunk_end) {
            const room = DEBUG_BUFFER_BYTES - debug_pos;
            if (room == 0) {
                // Oversized line: flush the prefix and keep accumulating.
                // Two events rather than one truncation, deliberately.
                flushDebug();
                continue;
            }
            const n = @min(chunk_end - j, room);
            @memcpy(debug_buffer[debug_pos .. debug_pos + n], src[j .. j + n]);
            debug_pos += n;
            j += n;
        }
        if (nl_rel != null) {
            flushDebug();
            i = chunk_end + 1;
        } else {
            i = chunk_end;
        }
    }
}

const DebugNode = struct {
    node: vfs.Node,

    const vtable: vfs.NodeVTable = .{
        .stat = stat,
        .read = readErr,
        .write = write,
        .close = closeFlush,
        .readdir = null,
        .lookup = null,
    };

    fn stat(_: *vfs.Node) vfs.VfsError!vfs.Stat {
        return .{ .filetype = .CHARACTER_DEVICE, .size = 0 };
    }
    fn readErr(_: *vfs.Node, _: u64, _: []u8) vfs.VfsError!usize {
        return vfs.VfsError.NotSupported;
    }
    fn write(_: *vfs.Node, _: u64, src: []const u8) vfs.VfsError!usize {
        appendDebug(src);
        return src.len;
    }
    /// Flush any partial line on close. `autoCloseAll` reaches us at
    /// program exit, so a `printf("hello")` without a trailing newline
    /// still surfaces in the host log.
    fn closeFlush(_: *vfs.Node) void {
        flushDebug();
    }
};

fn allocDebugNode(alloc: state_mod.Allocator) !*vfs.Node {
    const bytes = alloc.alloc(alloc.ctx, @sizeOf(DebugNode));
    const node: *DebugNode = @ptrCast(@alignCast(bytes.ptr));
    node.* = .{ .node = .{ .vtable = &DebugNode.vtable } };
    return &node.node;
}

// -- shared helpers -----------------------------------------------------

fn growCapacity(current: usize, needed: usize) usize {
    var cap: usize = if (current == 0) 64 else current;
    while (cap < needed) cap *= 2;
    return cap;
}
