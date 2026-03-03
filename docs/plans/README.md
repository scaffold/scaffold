# Implementation Plans

Detailed plans for building the Scaffold client library. See also:
- `docs/client-interface.md` — public API design
- `docs/implementation-plan.md` — architecture overview and phasing

## Dependency Graph

```
Phase 0: Foundation
  00-folder-reorganization  ← no deps

Phase 1: Minimal local (fetch + put on single node)
  02-reactive-layer         ← 00
  03-node-context           ← 00, 02
  06-put-manager            ← 00, 02
  04-fetch-manager          ← 00, 02, 06
  05-fetch-notify-strategy  ← 02, 04
  01-scaffold-facade        ← 00, 03

Phase 2: Contract execution
  07-contract-executor      ← 00
  08-generation-strategy    ← 02, 06, 07

Phase 3: Networking
  11-peer-connection        ← 00
  12-network-protocol       ← 00, 11
  10-network-manager        ← 00, 02, 11

Phase 4: Reactive behaviors
  09-aggregation-strategy   ← 02, 06
  14-sampling-strategy      ← 02, 07
  16-dispute-strategy       ← 02, 06, 07, 14

Phase 5: Persistence & cleanup
  13-storage-manager        ← 00, 02
  15-garbage-collector      ← 00
```

## Plan Index

| # | Plan | Summary |
|---|------|---------|
| 00 | [Folder Reorganization](00-folder-reorganization.md) | Move files into core/, node/, legacy2/ |
| 01 | [Scaffold Facade](01-scaffold-facade.md) | Public API: fetch, put, close, context |
| 02 | [Reactive Layer](02-reactive-layer.md) | Strategy evaluation loop |
| 03 | [Node Context](03-node-context.md) | Internal wiring and plugin management |
| 04 | [Fetch Manager](04-fetch-manager.md) | Active fetch subscriptions and dedup |
| 05 | [Fetch Notify Strategy](05-fetch-notify-strategy.md) | Notify fetches on canonicality changes |
| 06 | [Put Manager](06-put-manager.md) | Block creation from put() requests |
| 07 | [Contract Executor](07-contract-executor.md) | JS contract execution with ContractContext |
| 08 | [Generation Strategy](08-generation-strategy.md) | React to incentive blocks, execute contracts |
| 09 | [Aggregation Strategy](09-aggregation-strategy.md) | React to canonical leaves, aggregate them |
| 10 | [Network Manager](10-network-manager.md) | Plugin lifecycle, bootstrap, peer routing |
| 11 | [Peer Connection](11-peer-connection.md) | Serialization + framing over transport |
| 12 | [Network Protocol](12-network-protocol.md) | Wire protocol message types |
| 13 | [Storage Manager](13-storage-manager.md) | Block persistence and restore |
| 14 | [Sampling Strategy](14-sampling-strategy.md) | Reactive verification scheduling |
| 15 | [Garbage Collector](15-garbage-collector.md) | LRU block eviction |
| 16 | [Dispute Strategy](16-dispute-strategy.md) | Create dispute blocks on verification failure |

## Not Yet Planned (see TODO.md)

These need protocol-level design work before implementation planning:

- **Execution Module** — what constitutes valid execution, WASM semantics
- **Verification Module** — spot-check procedure, re-execution mechanics
- **Dispute Module** — FOR/AGAINST resolution, voting, evidence
- **Peer Module** — discovery, quality scoring, disconnection heuristics
- **Request Routing** — how incentive blocks reach capable peers
- **Computation DAG** — ctx.request() semantics, cancellation, cycle detection
