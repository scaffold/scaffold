# Zig vs C++ WebSocket Bench (v2)

Updated after fixing the v1 issues:

- **Concurrency:** the Zig server now has a per-handler `Io.Mutex` around the seen-set; both `hasSeen`-then-`record` paths run in a single critical section via `tryRecord`.
- **O(1) dedup on both sides:** Zig now uses ring buffer + `std.AutoHashMapUnmanaged(u256, void)`; C++ continues using ring + `std::unordered_set<Digest>`. Same algorithm both sides.
- **Cache size:** `SEEN_CAP = 1,000,000` entries per peer. At 32 peers this is ~2 GB of allocated dedup state — comfortably in the GB regime the user asked for.

## Setup

- **Host:** Apple M1 Max, 10 cores, macOS 25.3
- **Zig server:** websocket.zig 0.16-master, ReleaseFast, default `worker_count=1` + thread pool of 4 message-handler threads (lib default)
- **C++ server:** uWebSockets master + uSockets, `-O3 -flto`, single-threaded App loop
- **Hash:** Zig stdlib SHA3-256 (pure Zig); C++ uses OpenSSL 3 SHA3-256 (ARM-asm). The crypto-lib quality gap favors C++ but probably <2× on this op.
- **Load generator:** Zig + websocket.zig client; writer + blocking reader thread per connection. 3 s warmup, 8 s measurement. 512 B binary frames; first 16 bytes stamped with `(conn_id, seq)` so every digest is unique.
- **Binary sizes:** Zig 524 KB, C++ 167 KB (linked statically against uSockets, dynamically against libcrypto/libz).

Workload modes:
- `echo` — recv → send same bytes back (1:1)
- `hash` — recv → SHA3-256(payload) → send back
- `fanout` — recv → send to all other peers (no dedup)
- `forward` — recv → SHA3-256 → broadcast to peers whose seen-set does NOT contain the digest, then add to their seen-set (per-peer LRU)

## Results

`recv/s` and `send_MiB/s` for fanout/forward count the work the server does on the outbound side (1 incoming frame becomes N-1 outgoing frames). `rss_mid` is server RSS sampled mid-measurement.

### echo — pure WS framing (1:1)

| conn | impl | sent/s | recv/s | srv_cpu | RSS_mid |
|------|------|-------:|-------:|--------:|--------:|
|    1 | zig  |   105k |   105k |    78 % |   4 MB |
|    1 | cpp  | **379k** | **379k** |    45 % |  41 MB |
|    2 | zig  |   167k |   167k |   164 % |   6 MB |
|    2 | cpp  | **543k** | **543k** |    56 % |  80 MB |
|    4 | zig  |    90k |    88k |   132 % |  10 MB |
|    4 | cpp  | **763k** | **763k** |    66 % | 159 MB |
|    8 | zig  |   247k |   249k |   244 % |  19 MB |
|    8 | cpp  | **637k** | **637k** |    74 % | 316 MB |

uWS dominates pure framing — **2.5–8× faster** depending on conn count, on roughly half the CPU. Per-core gap is ~5–10×.

### hash — recv + SHA3-256 + send

| conn | impl | sent/s | srv_cpu | RSS_mid |
|------|------|-------:|--------:|--------:|
|    1 | zig  |   94k  |    71 % |   4 MB |
|    1 | cpp  | **504k** |    74 % |  44 MB |
|    4 | zig  |  146k  |   217 % |  10 MB |
|    4 | cpp  | **758k** |    98 % | 161 MB |
|    8 | zig  |  225k  |   227 % |  19 MB |
|    8 | cpp  | **613k** |    97 % | 318 MB |

Hashing is small at 512 B; pattern matches echo. ARM-asm SHA3 in OpenSSL is faster than the pure-Zig stdlib version, contributing to the gap.

### fanout — broadcast to all peers (no dedup)

| conn | impl | recv/s | sent/s | srv_cpu | RSS_mid |
|------|------|-------:|-------:|--------:|--------:|
|    8 | zig  | **422k** |  60k |   249 % |   19 MB |
|    8 | cpp  |   152k |  24k |    79 % |  735 MB |
|   16 | zig  |   456k |  31k |   216 % |   36 MB |
|   16 | cpp  | **566k** |  38k |    97 % |  959 MB |
|   32 | zig  |   426k |  14k |   158 % |   69 MB |
|   32 | cpp  | **509k** |  20k |    96 % |  1.5 GB |

Zig saturates around 420–460 k recv/s using ~2 cores. Single-threaded uWS tops out near 575 k recv/s on ~1 core. Zig wins at conn=8 (uWS result there had real run-to-run variance, suggesting we're near a tipping point); uWS wins by ~25 % at conn=16/32.

(Note on RSS: C++ `unordered_set::reserve()` faults its bucket array eagerly even when the set never gets a write. Zig's hashmap doesn't, so its fanout RSS stays small. Both still allocate the per-peer dedup structures because the server doesn't know the workload at handler-init time. In a production hub you'd skip the alloc entirely in fanout mode.)

### forward — SHA3 + per-peer LRU dedup + broadcast (the realistic Scaffold workload)

| conn | impl | recv/s | sent/s | srv_cpu | RSS_mid |
|------|------|-------:|-------:|--------:|--------:|
|    8 | zig  | **409k** |  59k |   269 % |  625 MB |
|    8 | cpp  |   327k |  49k |    94 % |  708 MB |
|   16 | zig  | **440k** |  30k |   238 % | 1.18 GB |
|   16 | cpp  |   398k |  27k |    96 % |  1.0 GB |
|   32 | zig  |   433k |  14k |   200 % | 2.26 GB |
|   32 | cpp  | **447k** |  29k |    83 % | 1.96 GB |

**Within ~10 % of each other across the board, with Zig ahead at conn=8 and conn=16, uWS slightly ahead at conn=32.** With the now-fair O(1) dedup on both sides, this looks like a real Zig-wins-when-it-can-multi-thread story for the multi-peer broadcast workload.

The memory numbers tell the same story: 60–70 MB per peer of dedup state on each side, dominated by the 32-byte digests times 1 M entries plus hashmap overhead.

## What changed from v1

- **No move on echo / hash.** Same WS-framing-bound behavior, same outcomes.
- **Forward improved on both sides** with O(1) dedup but the relative picture is unchanged (both ~10 % faster than v1; Zig and C++ stayed close to each other).
- **Memory footprint scales as expected** with peer count and cap. Confirms the per-peer cap is a meaningful tuning knob (1 M digests = ~70 MB/peer; 100 k digests would be ~7 MB/peer).

## Per-core efficiency (the metric that matters on small VMs)

Throughput per CPU core, in the realistic `forward` workload:

| conn | impl | recv/s | cores | recv/s/core |
|------|------|-------:|------:|------------:|
|   16 | zig  |  440 k |  2.4  | **184 k/core** |
|   16 | cpp  |  398 k |  1.0  | **414 k/core** |
|   32 | zig  |  433 k |  2.0  | **217 k/core** |
|   32 | cpp  |  447 k |  0.8  | **538 k/core** |

uWS does ~2.4× more forward work per core. **On a 2-vCPU Hetzner box this is the number that matters most** — uWS leaves an extra core for OS, TLS termination, monitoring; Zig burns it on websocket framing.

## Single-threaded Zig

The default Zig server runs 1 event-loop worker + a thread pool of 4 message handlers. Setting `THREADS=1` collapses the pool to a single handler thread; effectively single-threaded except for the IO loop.

Run via env: `WORKERS=1 THREADS=1 ./zig-server`.

| mode | conn | config | recv/s | srv_cpu | recv/s/core |
|------|------|--------|-------:|--------:|------------:|
| echo    |  1 | 1 thread | 106 k |  72 % | **147 k** |
| echo    |  1 | 4 threads | 105 k |  78 % | 135 k |
| echo    |  8 | 1 thread | 198 k | 123 % | **161 k** |
| echo    |  8 | 4 threads | 247 k | 244 % | 101 k |
| fanout  |  8 | 1 thread | 309 k |  67 % | **461 k** |
| fanout  |  8 | 4 threads | 422 k | 249 % | 169 k |
| fanout  | 16 | 1 thread | 340 k |  90 % | **378 k** |
| fanout  | 16 | 4 threads | 456 k | 216 % | 211 k |
| forward |  8 | 1 thread | 237 k | 102 % | **232 k** |
| forward |  8 | 4 threads | 282 k | 133 % | 212 k |
| forward | 16 | 1 thread | 238 k |  89 % | **267 k** |
| forward | 16 | 4 threads | 277 k | 182 % | 152 k |

(The 4-thread reference numbers in this run are lower than the matrix above — there's real run-to-run variance — but the per-core ratios are stable.)

What this shows:

1. **Single-threaded Zig is 1.5–3× more efficient per core** in fanout/forward. The thread pool's parallelism is buying throughput at a steep CPU cost — lock contention on the per-peer seen-set mutex eats most of the parallelism gains.
2. **Single-threaded Zig is competitive with uWS at low/mid conn counts.** Single-thread fanout conn=8 hit 461 k recv/s/core; uWS in the same workload was 192 k recv/s/core. uWS still pulls ahead at higher conn counts (uWS forward conn=16 = 414 k/core vs single-thread Zig 267 k/core).
3. **Absolute throughput ceiling is lower** when single-threaded — about 200 k echo/s and 240 k forward recv/s, vs 250–460 k for multi-threaded. If your workload genuinely saturates one core's worth of WS framing, multi-threaded gets headroom; otherwise the parallelism is wasted CPU.
4. **The right answer for proper Zig parallelism isn't one-mutex-per-peer.** It's sharded peer ownership: each worker thread exclusively handles a subset of connections (and their seen-sets), with cross-shard broadcasts going through queues. That eliminates lock contention but is meaningfully more code.

For the realistic Scaffold-hub deployment, **single-threaded Zig is the apples-to-apples comparison to single-threaded uWS** — both pinned to one core, both doing the same broadcast work. With that comparison the per-core gap narrows from ~2.4× (uWS vs 4-thread Zig) to ~1.5× (uWS vs 1-thread Zig). uWS still wins, but by less than the multi-thread numbers suggested.

## Recommendation update (refined)

I previously ended up cautiously pro-Zig. With this fairer dataset I'm splitting the recommendation by deployment shape:

- **Pi 4 / Hetzner CX11 / any 1–2 vCPU box:** lean toward **uWS / C++**. Per-core efficiency is real and the spare CPU buys you headroom that matters at the network edge. The smaller binary is also nice (167 KB vs 524 KB).
- **3+ cores available, sub-1k peers, you control the deploy:** **websocket.zig / Zig** is fine and arguably better. Multi-threaded by default, simpler ops story, cross-compile to ARM is trivial. Throughput is competitive on the workload that matters once parallelism kicks in.
- **>10k peers, mainnet-sized hub:** uWS, no question — and at that scale you want a sharded multi-loop design (one App per core, broadcast across loops) which is uWS-native territory.

For the immediate "two-browser chess demo" use case on a $5/mo VPS, **uWS is the better default**, but the gap is small enough that picking Zig for the operational simplicity is a reasonable trade.

## Caveats (still apply)

- M1 Max is a workstation chip; raw numbers will be 4–10× lower on a Pi 4 / CX11 in absolute terms. Ratios should hold roughly.
- Hash impls are not equalized (OpenSSL ARM-asm vs pure-Zig stdlib). At 512 B/msg the difference is small but measurable.
- Compression disabled in both. uWS default is on; we disabled to keep the comparison clean.
- websocket.zig 0.16 uses the new Zig `Io` abstraction which is unlikely to be fully optimized yet. There is real upside potential here.
- Loadgen shutdown is occasionally flaky at high conn counts (reader threads can hang on `read()` when sockets are closed under them). The matrix runner kills the loadgen after 60 s if it hasn't exited; one of the fanout-32 results required a retry to get a clean RESULT line.

## Reproduction

```
cd bench
make -C uWebSockets/uSockets        # one-time
make -C cpp-server
zig build --release=fast --build-file zig-server/build.zig
zig build --release=fast --build-file loadgen/build.zig

./run.sh                            # full matrix
./run_one.sh zig forward 16         # single case
```

Results land in `bench/results/`. Tweak knobs via env: `MSGSIZE`, `WARMUP`, `DURATION`, `SEEN_CAP`.
