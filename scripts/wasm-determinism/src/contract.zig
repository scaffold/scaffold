// Scaffold contract wrapper for the wasm-determinism transformer. Same WASM
// blob can be deployed as two contracts (transform / verify) that differ only
// in a metadata record on the contract's introducing block.
//
// Spec: docs/protocol/wasm-abi.md

const std = @import("std");
const transform_mod = @import("transform.zig");
const scaffold = @import("scaffold_env.zig");
const wire = @import("wire.zig");
const sha3 = @import("sha3.zig");
const well_known = @import("well_known.zig");

const MODE_KEY = "scaffold-determinism-mode";

const Mode = enum { transform, verify };

// -- Bump allocator backed by linear memory ---------------------------------
//
// The Scaffold host calls into this contract's exported `alloc` from import
// handlers (e.g. to drop returned bytes from `fetch` into our memory). The
// allocator must therefore be available outside `run`'s call frame, so we
// keep its cursor in a module-level global initialised to __heap_base.

extern const __heap_base: u8;

var bump_cursor: u32 = 0;
var bump_initialised: bool = false;

fn bumpInit() void {
    if (bump_initialised) return;
    bump_cursor = @intCast(@intFromPtr(&__heap_base));
    bump_initialised = true;
}

fn bumpAlloc(n: u32, alignment: u32) [*]u8 {
    bumpInit();
    const align_mask: u32 = alignment - 1;
    const aligned: u32 = (bump_cursor + align_mask) & ~align_mask;
    const end = aligned + n;
    // Grow memory if needed. WebAssembly memory.grow rounds up to pages.
    const PAGE: u32 = 65536;
    const current_pages: u32 = @intCast(@wasmMemorySize(0));
    const needed_pages: u32 = (end + PAGE - 1) / PAGE;
    if (needed_pages > current_pages) {
        const delta = needed_pages - current_pages;
        const grow_result = @wasmMemoryGrow(0, delta);
        if (grow_result == -1) {
            scaffold.doReject("memory.grow failed");
        }
    }
    bump_cursor = end;
    const base: [*]u8 = @ptrFromInt(@as(usize, aligned));
    return base;
}

export fn alloc(n: u32) u32 {
    const p = bumpAlloc(n, 8);
    // Zero-fill is required by the ABI.
    @memset(p[0..n], 0);
    return @intCast(@intFromPtr(p));
}

// -- std.mem.Allocator vtable that uses our bump allocator ------------------

const BumpAllocator = struct {
    fn allocFn(_: *anyopaque, n: usize, alignment: std.mem.Alignment, _: usize) ?[*]u8 {
        const align_log2: u8 = @intFromEnum(alignment);
        const align_bytes: u32 = @as(u32, 1) << @intCast(align_log2);
        return bumpAlloc(@intCast(n), align_bytes);
    }
    fn resizeFn(_: *anyopaque, _: []u8, _: std.mem.Alignment, _: usize, _: usize) bool {
        return false;
    }
    fn remapFn(_: *anyopaque, _: []u8, _: std.mem.Alignment, _: usize, _: usize) ?[*]u8 {
        return null;
    }
    fn freeFn(_: *anyopaque, _: []u8, _: std.mem.Alignment, _: usize) void {}
};

const bump_vtable = std.mem.Allocator.VTable{
    .alloc = BumpAllocator.allocFn,
    .resize = BumpAllocator.resizeFn,
    .remap = BumpAllocator.remapFn,
    .free = BumpAllocator.freeFn,
};

fn bumpAllocator() std.mem.Allocator {
    return .{ .ptr = undefined, .vtable = &bump_vtable };
}

fn noOpLog(_: []const u8) void {}

// -- Mode resolution --------------------------------------------------------

fn readMode() Mode {
    var verifier_buf: [wire.HASH_LEN + 4 + MODE_KEY.len]u8 = undefined;
    const v_len = wire.encodeVerifier(well_known.RECORD_CONTRACT, MODE_KEY, &verifier_buf);
    const reply = scaffold.doContractMetadata(verifier_buf[0..v_len]);
    if (std.mem.eql(u8, reply.body, "transform")) return .transform;
    if (std.mem.eql(u8, reply.body, "verify")) return .verify;
    scaffold.doReject("unknown scaffold-determinism-mode");
}

fn emitRecord(key: []const u8, body: []const u8) void {
    const a = bumpAllocator();
    const size = wire.outputSize(key.len, body.len);
    const buf = a.alloc(u8, size) catch scaffold.doReject("alloc failed");
    const n = wire.encodeOutput(well_known.RECORD_CONTRACT, key, 0, body, buf);
    scaffold.doEmitOutput(buf[0..n]);
}

// -- Entry point ------------------------------------------------------------

export fn run() void {
    const mode = readMode();

    const params_bytes = scaffold.getParams();
    if (params_bytes.len != 32) {
        scaffold.doReject("params must be a 32-byte input WASM hash");
    }
    const input_hash: [32]u8 = params_bytes[0..32].*;

    // Build the HASH_CONTRACT verifier and fetch the input WASM bytes.
    var hash_verifier_buf: [wire.HASH_LEN + 4 + 32]u8 = undefined;
    const hv_len = wire.encodeVerifier(well_known.HASH_CONTRACT, &input_hash, &hash_verifier_buf);
    const input_bytes = scaffold.doFetch(hash_verifier_buf[0..hv_len], "default");

    // Allocate output buffer. Transform sometimes inserts canonicalisation /
    // grow guards; budget 2x the input plus 1 KiB for headers / version
    // section.
    const a = bumpAllocator();
    const out_buf = a.alloc(u8, input_bytes.len * 2 + 1024) catch scaffold.doReject("alloc failed");

    const result = transform_mod.run(.{
        .input = input_bytes,
        .output = out_buf,
        .allocator = a,
        .logFn = noOpLog,
    }) catch |err| switch (err) {
        error.Banned => scaffold.doReject("banned WASM content"),
        error.NeedsAbstain => scaffold.doReject("memory.grow used without env.abstain import"),
        error.Malformed, error.Overflow, error.EndOfStream => scaffold.doReject("malformed WASM"),
        error.OutOfMemory => scaffold.doReject("out of memory during transform"),
    };

    switch (mode) {
        .transform => emitTransform(result, out_buf, input_hash),
        .verify => verifyMode(result),
    }
}

fn emitTransform(
    result: transform_mod.Result,
    out_buf: []u8,
    input_hash: [32]u8,
) void {
    switch (result) {
        .unchanged => {
            // No bytes change -> output hash equals input hash. Emit the
            // hash record only; no bytes record.
            emitRecord("default", &input_hash);
        },
        .transformed => |n| {
            const out_hash = sha3.digest(out_buf[0..n]);
            emitRecord("default", &out_hash);
            emitRecord("outputWasmBytes", out_buf[0..n]);
        },
    }
}

fn verifyMode(result: transform_mod.Result) void {
    switch (result) {
        .unchanged => {
            // Already deterministic. Accept silently.
        },
        .transformed => {
            scaffold.doReject("input is not already deterministic");
        },
    }
}
