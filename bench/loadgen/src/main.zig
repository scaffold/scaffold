// Load generator for the WebSocket bench servers.
//
// For each of N connections, spawns 2 threads:
//   - writer: tight loop sending B-byte binary messages
//   - reader: blocking read loop, counts received messages
//
// Driver runs WARMUP seconds (counters reset after) then DURATION seconds
// of measured throughput.
//
// Args (env vars):
//   HOST=127.0.0.1
//   PORT=8080
//   CONNECTIONS=16
//   MSGSIZE=1024
//   WARMUP=3
//   DURATION=10
//   PATH_=/

const std = @import("std");
const websocket = @import("websocket");

var g_total_sent: std.atomic.Value(u64) = .init(0);
var g_total_recv: std.atomic.Value(u64) = .init(0);
var g_bytes_sent: std.atomic.Value(u64) = .init(0);
var g_bytes_recv: std.atomic.Value(u64) = .init(0);
var g_stop: std.atomic.Value(bool) = .init(false);
var g_started: std.atomic.Value(u32) = .init(0);

const Args = struct {
    host: []const u8,
    port: u16,
    connections: u32,
    msg_size: u32,
    warmup_s: u64,
    duration_s: u64,
    path: []const u8,
};

const Conn = struct {
    io: std.Io,
    allocator: std.mem.Allocator,
    args: *const Args,
    id: u32,
    client: websocket.Client = undefined,
    handshake_ok: bool = false,

    fn open(self: *Conn) !void {
        self.client = try websocket.Client.init(self.io, self.allocator, .{
            .port = self.args.port,
            .host = self.args.host,
            .max_size = 8 * 1024 * 1024,
            .buffer_size = 64 * 1024,
        });
        errdefer self.client.deinit();

        var host_header_buf: [128]u8 = undefined;
        const host_header = try std.fmt.bufPrint(&host_header_buf, "Host: {s}:{d}", .{ self.args.host, self.args.port });
        try self.client.handshake(self.args.path, .{
            .timeout_ms = 10_000,
            .headers = host_header,
        });
        self.handshake_ok = true;
        _ = g_started.fetchAdd(1, .release);
    }

    fn writerRun(self: *Conn) void {
        const buf = self.allocator.alloc(u8, self.args.msg_size) catch return;
        defer self.allocator.free(buf);
        for (buf, 0..) |*b, i| b.* = @as(u8, @truncate(i));

        var local_sent: u64 = 0;
        var local_bs: u64 = 0;
        var seq: u64 = 0;

        while (!g_stop.load(.acquire)) {
            // Stamp a unique sequence into the first 16 bytes (8 bytes conn id,
            // 8 bytes seq). Forward-mode dedup only blocks duplicates, so we
            // need every message digest to be unique.
            if (buf.len >= 16) {
                std.mem.writeInt(u64, buf[0..8], self.id, .little);
                std.mem.writeInt(u64, buf[8..16], seq, .little);
            }
            seq += 1;

            self.client.writeBin(buf) catch break;
            local_sent += 1;
            local_bs += buf.len;

            if ((local_sent & 0xff) == 0) {
                _ = g_total_sent.fetchAdd(local_sent, .monotonic);
                _ = g_bytes_sent.fetchAdd(local_bs, .monotonic);
                local_sent = 0;
                local_bs = 0;
            }
        }
        _ = g_total_sent.fetchAdd(local_sent, .monotonic);
        _ = g_bytes_sent.fetchAdd(local_bs, .monotonic);
    }

    fn readerRun(self: *Conn) void {
        var local_recv: u64 = 0;
        var local_br: u64 = 0;

        while (!g_stop.load(.acquire)) {
            const maybe = self.client.read() catch break;
            const msg = maybe orelse continue;
            local_recv += 1;
            local_br += msg.data.len;
            self.client.done(msg);

            if ((local_recv & 0xff) == 0) {
                _ = g_total_recv.fetchAdd(local_recv, .monotonic);
                _ = g_bytes_recv.fetchAdd(local_br, .monotonic);
                local_recv = 0;
                local_br = 0;
            }
        }
        _ = g_total_recv.fetchAdd(local_recv, .monotonic);
        _ = g_bytes_recv.fetchAdd(local_br, .monotonic);
    }
};

fn parseEnv(comptime T: type, env: *std.process.Environ.Map, name: []const u8, default: T) T {
    const s = env.get(name) orelse return default;
    return std.fmt.parseInt(T, s, 10) catch default;
}

pub fn main(init: std.process.Init) !void {
    const allocator = init.gpa;
    const env = init.environ_map;

    var args = Args{
        .host = env.get("HOST") orelse "127.0.0.1",
        .port = parseEnv(u16, env, "PORT", 8080),
        .connections = parseEnv(u32, env, "CONNECTIONS", 16),
        .msg_size = parseEnv(u32, env, "MSGSIZE", 1024),
        .warmup_s = parseEnv(u64, env, "WARMUP", 3),
        .duration_s = parseEnv(u64, env, "DURATION", 10),
        .path = env.get("PATH_") orelse "/",
    };

    std.debug.print(
        "loadgen host={s}:{d} connections={d} msg_size={d} warmup={d}s duration={d}s\n",
        .{ args.host, args.port, args.connections, args.msg_size, args.warmup_s, args.duration_s },
    );

    const conns = try allocator.alloc(Conn, args.connections);
    defer allocator.free(conns);
    for (conns, 0..) |*c, i| {
        c.* = .{ .io = init.io, .allocator = allocator, .args = &args, .id = @intCast(i) };
    }

    // Open and handshake all connections sequentially to keep things deterministic.
    for (conns) |*c| {
        c.open() catch |err| {
            std.debug.print("conn {d} open failed: {s}\n", .{ c.id, @errorName(err) });
            return err;
        };
    }
    std.debug.print("ready: {d}/{d} connections\n", .{ args.connections, args.connections });

    // Spawn writer + reader thread per connection.
    const threads = try allocator.alloc(std.Thread, args.connections * 2);
    defer allocator.free(threads);

    for (conns, 0..) |*c, i| {
        threads[i * 2] = try std.Thread.spawn(.{}, Conn.writerRun, .{c});
        threads[i * 2 + 1] = try std.Thread.spawn(.{}, Conn.readerRun, .{c});
    }

    // Warmup
    std.Io.sleep(init.io, std.Io.Duration.fromSeconds(@intCast(args.warmup_s)), .awake) catch {};

    g_total_sent.store(0, .release);
    g_total_recv.store(0, .release);
    g_bytes_sent.store(0, .release);
    g_bytes_recv.store(0, .release);

    const t_start = std.Io.Timestamp.now(init.io, .awake);
    std.Io.sleep(init.io, std.Io.Duration.fromSeconds(@intCast(args.duration_s)), .awake) catch {};
    const t_end = std.Io.Timestamp.now(init.io, .awake);
    g_stop.store(true, .release);

    // Best-effort: nudge each socket so the reader thread unblocks.
    for (conns) |*c| {
        c.client.close(.{}) catch {};
    }

    for (threads) |t| t.join();

    const elapsed_ns_i = t_start.durationTo(t_end).nanoseconds;
    const elapsed_s: f64 = @as(f64, @floatFromInt(elapsed_ns_i)) / @as(f64, std.time.ns_per_s);
    const sent = g_total_sent.load(.monotonic);
    const recv = g_total_recv.load(.monotonic);
    const bs = g_bytes_sent.load(.monotonic);
    const br = g_bytes_recv.load(.monotonic);

    const sent_per_s = @as(f64, @floatFromInt(sent)) / elapsed_s;
    const recv_per_s = @as(f64, @floatFromInt(recv)) / elapsed_s;
    const mib_s_send = @as(f64, @floatFromInt(bs)) / (elapsed_s * 1024.0 * 1024.0);
    const mib_s_recv = @as(f64, @floatFromInt(br)) / (elapsed_s * 1024.0 * 1024.0);

    std.debug.print(
        "RESULT elapsed={d:.2}s sent={d} recv={d} sent/s={d:.0} recv/s={d:.0} send_MiB/s={d:.1} recv_MiB/s={d:.1}\n",
        .{ elapsed_s, sent, recv, sent_per_s, recv_per_s, mib_s_send, mib_s_recv },
    );
}
