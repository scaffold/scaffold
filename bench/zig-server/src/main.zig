// Bench server: receives WS messages and applies a configurable workload.
//
// Modes (set via env WORKLOAD=...):
//   echo     -- write the message back to sender
//   hash     -- SHA3-256 the bytes, then write back to sender
//   fanout   -- write to all OTHER connected clients (no hash, no dedup)
//   forward  -- SHA3-256, dedup against per-peer LRU, then fan out to peers
//                whose seen-set does not contain the hash
//
// Port: 8080 (env PORT). Cache size: 1M entries / peer (env SEEN_CAP).

const std = @import("std");
const websocket = @import("websocket");

const Sha3 = std.crypto.hash.sha3.Sha3_256;

const Mode = enum { echo, hash, fanout, forward };

const App = struct {
    mode: Mode,
    seen_cap: u32,
    io: std.Io,
    mutex: std.Io.Mutex = .init,
    peers: std.AutoHashMapUnmanaged(usize, *Handler) = .empty,
    next_id: usize = 0,
    allocator: std.mem.Allocator,

    fn register(self: *App, h: *Handler) !void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        h.id = self.next_id;
        self.next_id += 1;
        try self.peers.put(self.allocator, h.id, h);
    }

    fn unregister(self: *App, h: *Handler) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        _ = self.peers.remove(h.id);
    }
};

// Per-peer LRU of seen packet hashes:
//   - ring buffer holds insertion order so we know what to evict
//   - hashmap (set) gives O(1) hasSeen
//   - per-peer mutex serialises access from concurrent worker threads
const Seen = struct {
    mutex: std.Io.Mutex = .init,
    ring: []u256,
    head: u32 = 0,
    len: u32 = 0,
    set: std.AutoHashMapUnmanaged(u256, void) = .empty,

    fn init(self: *Seen, allocator: std.mem.Allocator, cap: u32) !void {
        self.* = .{ .ring = try allocator.alloc(u256, cap) };
        try self.set.ensureTotalCapacity(allocator, cap);
    }

    fn deinit(self: *Seen, allocator: std.mem.Allocator) void {
        allocator.free(self.ring);
        self.set.deinit(allocator);
    }

    fn recordLocked(self: *Seen, allocator: std.mem.Allocator, digest: u256) void {
        if (self.len == self.ring.len) {
            const evict = self.ring[self.head];
            _ = self.set.remove(evict);
        }
        self.ring[self.head] = digest;
        self.head = (self.head + 1) % @as(u32, @intCast(self.ring.len));
        if (self.len < self.ring.len) self.len += 1;
        self.set.put(allocator, digest, {}) catch {};
    }

    fn record(self: *Seen, allocator: std.mem.Allocator, io: std.Io, digest: u256) void {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        self.recordLocked(allocator, digest);
    }

    // Returns true if the digest was newly inserted (i.e. not previously seen).
    // One critical section instead of has() + record().
    fn tryRecord(self: *Seen, allocator: std.mem.Allocator, io: std.Io, digest: u256) bool {
        self.mutex.lockUncancelable(io);
        defer self.mutex.unlock(io);
        if (self.set.contains(digest)) return false;
        self.recordLocked(allocator, digest);
        return true;
    }
};

const Handler = struct {
    app: *App,
    conn: *websocket.Conn,
    id: usize = 0,
    seen: Seen = undefined,
    seen_inited: bool = false,

    pub fn init(_: *websocket.Handshake, conn: *websocket.Conn, app: *App) !Handler {
        return .{ .app = app, .conn = conn };
    }

    pub fn afterInit(self: *Handler) !void {
        try self.seen.init(self.app.allocator, self.app.seen_cap);
        self.seen_inited = true;
        try self.app.register(self);
    }

    pub fn close(self: *Handler) void {
        self.app.unregister(self);
        if (self.seen_inited) {
            self.seen.deinit(self.app.allocator);
        }
    }

    pub fn clientMessage(self: *Handler, data: []const u8) !void {
        switch (self.app.mode) {
            .echo => {
                try self.conn.writeBin(data);
            },
            .hash => {
                var digest: [32]u8 = undefined;
                Sha3.hash(data, &digest, .{});
                std.mem.doNotOptimizeAway(&digest);
                try self.conn.writeBin(data);
            },
            .fanout => {
                self.broadcast(data, false, 0);
            },
            .forward => {
                var digest_bytes: [32]u8 = undefined;
                Sha3.hash(data, &digest_bytes, .{});
                const digest = std.mem.readInt(u256, &digest_bytes, .little);
                self.seen.record(self.app.allocator, self.app.io, digest);
                self.broadcast(data, true, digest);
            },
        }
    }

    fn broadcast(self: *Handler, data: []const u8, dedup: bool, digest: u256) void {
        // Snapshot peer pointers under the app mutex (very short critical
        // section). Each peer's seen set has its own mutex so we drop the
        // app lock before iterating.
        const io = self.app.io;
        self.app.mutex.lockUncancelable(io);
        var snapshot_buf: [4096]*Handler = undefined;
        var n: usize = 0;
        var it = self.app.peers.iterator();
        while (it.next()) |entry| {
            const peer = entry.value_ptr.*;
            if (peer == self) continue;
            if (n >= snapshot_buf.len) break;
            snapshot_buf[n] = peer;
            n += 1;
        }
        self.app.mutex.unlock(io);

        const allocator = self.app.allocator;
        var i: usize = 0;
        while (i < n) : (i += 1) {
            const peer = snapshot_buf[i];
            if (dedup) {
                if (!peer.seen.tryRecord(allocator, io, digest)) continue;
            }
            peer.conn.writeBin(data) catch {};
        }
    }
};

fn parseMode(s: []const u8) ?Mode {
    if (std.mem.eql(u8, s, "echo")) return .echo;
    if (std.mem.eql(u8, s, "hash")) return .hash;
    if (std.mem.eql(u8, s, "fanout")) return .fanout;
    if (std.mem.eql(u8, s, "forward")) return .forward;
    return null;
}

pub fn main(init: std.process.Init) !void {
    const allocator = init.gpa;

    var mode: Mode = .echo;
    var port: u16 = 8080;
    var seen_cap: u32 = 1_000_000;
    var workers: u8 = 1;
    var threads: u16 = 4;
    if (init.environ_map.get("WORKLOAD")) |s| {
        mode = parseMode(s) orelse return error.InvalidWorkload;
    }
    if (init.environ_map.get("PORT")) |s| {
        port = try std.fmt.parseInt(u16, s, 10);
    }
    if (init.environ_map.get("SEEN_CAP")) |s| {
        seen_cap = try std.fmt.parseInt(u32, s, 10);
    }
    if (init.environ_map.get("WORKERS")) |s| {
        workers = try std.fmt.parseInt(u8, s, 10);
    }
    if (init.environ_map.get("THREADS")) |s| {
        threads = try std.fmt.parseInt(u16, s, 10);
    }

    var app = App{
        .mode = mode,
        .seen_cap = seen_cap,
        .io = init.io,
        .allocator = allocator,
    };
    defer app.peers.deinit(allocator);

    var server = try websocket.Server(Handler).init(init.io, allocator, .{
        .port = port,
        .address = "0.0.0.0",
        .max_message_size = 1 * 1024 * 1024,
        .worker_count = workers,
        .thread_pool = .{ .count = threads },
        .handshake = .{
            .timeout = 5,
            .max_size = 1024,
            .max_headers = 0,
        },
    });
    defer server.deinit();

    std.debug.print("zig-server mode={s} port={d} seen_cap={d} workers={d} threads={d}\n", .{ @tagName(mode), port, seen_cap, workers, threads });
    try server.listen(&app);
}
