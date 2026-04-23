# Plan: SyncProtocol — recursive ancestor fetch

Scope: M1.1 from `ROADMAP.md` (Block fetching in SyncProtocol: recursive ancestor
fetch, request batching, timeout/retry with peer rotation). Unblocks M1.2
(multi-node integration tests).

Branch: `claude/nifty-dijkstra-MR00C`

---

## Context

- `src/node/SyncProtocol.ts` is a 70-line tip-exchange stub.
- `grep -r 'new SyncProtocol('` returns only `tests/SyncProtocol.test.ts` —
  the class is never instantiated in `src/`.
- `NetworkBridge.handlePeerConnected` registers `onRequest`, `onDelivery`,
  `onSignal`, but **not** `onSync`. `initSync` is never called.
- Protocol doc `docs/protocol/sync.md` does not exist.
- Wire packets are already defined (`PacketType.Sync`, `Request`, `Block`) in
  `src/core/Packet.ts`, and `PeerConnection` already exposes `sendSync`,
  `requestBlocks`, `onSync`, `onRequest`. Wire layer is good — only the
  behavioral layer above it is missing.

## Daily goal

Turn `SyncProtocol` into a real module and wire it into `NetworkBridge` and
`Scaffold`. Land a two-node `UnixSocketTransport` integration test that
proves divergent chains converge.

## Out of scope for today

- WebRTC browser-to-browser integration tests (half of M1.2 proper).
- Gossip changes.
- Any M2 work (trust, verification automation, collateral posting).
- Changes to wire packets or `FetchManager`.

---

## Open questions (resolve before starting)

1. **Algorithm — frontier-batched (default) or depth-first?**
   Frontier-batched: maintain `missing: Set<HashPrimitive>`, batch up to N (32)
   hashes per request. Discover new missing hashes from each arriving block.
2. **Sync vs FetchManager.** Sync is standalone; no incentives, no contract
   execution. `FetchManager` remains untouched.
3. **Exhaustion behavior.** All known peers time out on a hash → warn + retry
   with exponential backoff capped at 30s.
4. **Which back-references to follow.** `anchor`, `aggregates[]`, `refs[]` all
   followed when unknown.
5. **Inbound request serving.** Move the existing `peer.onRequest` handler
   from `NetworkBridge` into `SyncProtocol.handleRequest` so all sync wire
   logic lives in one place.
6. **New protocol doc.** Yes — `docs/protocol/sync.md`. Add to module map in
   `docs/protocol/overview.md` and source↔doc table in `AGENTS.md`.

---

## Session-sized chunks

### Chunk 1 — Protocol doc + skeleton (~45 min)

- `docs/protocol/sync.md`: tip exchange, missing-set computation, batched
  request, timeout + peer rotation, quiescence, failure modes.
- Extend `SyncProtocol` class surface:
  - `addPeer(peer)`
  - `removePeer(peerId)`
  - `onBlockArrived(block)`
  - `handleRequest(peer, hashes)`
  - `stop()`
- Stub each method with a `TODO` and the invariants it has to uphold.
- Update module map in `docs/protocol/overview.md` and table in `AGENTS.md`.

### Chunk 2 — State-machine tests (~60 min)

File: extend `tests/SyncProtocol.test.ts`. Use the existing `MockTransport`.
Lock these invariants:

- Peer connects → `initSync` sent once.
- Receive tips with greater depth → unknown tips enqueued in `missing`.
- Block arrives whose `anchor` / `aggregates[i]` / `refs[i]` is unknown →
  those hashes are enqueued.
- Batch flushes at size cap (32) or on tick.
- In-flight request times out → rotated to next peer, failing peer's failure
  count increments.
- Peer disconnects mid-request → in-flight hashes re-enter `missing`.
- All ancestors received → `missing` empties → no more outbound requests.
- No healthy peers → warn logged, retry with exponential backoff.

### Chunk 3 — Frontier fetcher + batching (~75 min)

- Data structures:
  - `missing: Set<HashPrimitive>`
  - `inFlight: Map<HashPrimitive, { peerId: string; deadline: number }>`
  - `peers: Map<string, { peer: PeerConnection; failures: number }>`
- `onBlockArrived(block)`:
  - For each of `block.anchor`, `...block.aggregates`, `...block.refs`,
    enqueue to `missing` if not in `store` and not `inFlight`.
- `flushBatch(peer)`:
  - Drain up to `MAX_BATCH = 32` hashes from `missing` not already `inFlight`.
  - `peer.requestBlocks(batch)`; mark in-flight with deadline.

### Chunk 4 — Timeout / retry / peer rotation (~60 min)

- Single `setInterval` (or tick-driven) sweep for `deadline < now` entries.
- On timeout: drop from `inFlight`, re-enter `missing`, rotate to next peer
  (round-robin), increment failing peer's failure count.
- Per-peer failure threshold → mark "bad for this round," skip until all
  peers hit threshold (round resets with exponential backoff).
- `stats()` method for tests and `ScaffoldDebug`.

### Chunk 5 — Wire into `NetworkBridge` + `Scaffold` (~45 min)

- Construct `SyncProtocol` in `NetworkBridge`, injecting:
  - `store`
  - `packetStore` (for serving inbound requests)
  - `getCanonicalTips`, `getCanonicalDepth` (consensus service handles)
  - `ctx.logger('sync')`
- `handlePeerConnected`:
  - `protocol.addPeer(peer)`
  - `peer.onSync(data => protocol.handleSync(peer, data.tips, data.depth))`
  - **Move** `peer.onRequest` handler into `SyncProtocol.handleRequest`.
- `onBlockReceived`: `protocol.onBlockArrived(block)` after `processBlock`.
- `handlePeerDisconnected`: `protocol.removePeer(peerId)`.
- Register `'sync'` scope in event log.
- Update `AGENTS.md` "Instrumented systems" list.

### Chunk 6 — Two-node UnixSocket integration test (~45–60 min)

File: `tests/network/sync_integration.test.ts`.

- Two `Scaffold` instances with `UnixSocketTransport` plugins, shared genesis.
- Build divergent chains on each side (shared genesis → A's chain
  `g → a1 → a2`; B's chain `g → b1 → b2 → b3`).
- `start()`, bootstrap B → A.
- Poll until both stores contain the full union and `getCanonicalView()` is
  identical.
- Second test: peer disconnects mid-sync; still-missing hashes stay enqueued;
  reconnect (or second peer appears) and sync resumes to convergence.

If time permits: partition/heal test. Otherwise defer to M1.2 proper.

---

## One-shot prompt

> We are implementing M1.1 from `ROADMAP.md` on branch
> `claude/nifty-dijkstra-MR00C`. `SyncProtocol` at
> `src/node/SyncProtocol.ts` is currently a 70-line tip-exchange stub and is
> not instantiated anywhere in `src/` — only in its unit test. Your job is to
> turn it into a real recursive ancestor fetcher with request batching,
> timeout/retry, and peer rotation, and wire it into `NetworkBridge`.
>
> Follow the 4-step sequence in `AGENTS.md`:
>
> 1. Write `docs/protocol/sync.md` covering: tip exchange, missing-set
>    computation, batched requests, timeout/rotation, quiescence. Update the
>    module map in `docs/protocol/overview.md` and the table in `AGENTS.md`.
> 2. Extend the test file `tests/SyncProtocol.test.ts` to cover: multi-peer
>    rotation on timeout, recursive discovery when a received block has
>    unknown `anchor`/`aggregates`/`refs`, batch size cap, retry-with-backoff
>    when all peers fail, peer-disconnects-mid-request. Reuse the existing
>    `MockTransport`.
> 3. Implement frontier-batched fetch (max batch size 32) with
>    `missing: Set<HashPrimitive>` and
>    `inFlight: Map<HashPrimitive, {peerId, deadline}>`. On
>    `onBlockArrived`, inspect `block.anchor`, `block.aggregates`,
>    `block.refs` and enqueue unknown hashes. Default request timeout 5s; on
>    timeout, re-enqueue and rotate to next peer. If all peers fail, warn and
>    retry with exponential backoff capped at 30s.
> 4. Wire into `src/node/NetworkBridge.ts`: construct `SyncProtocol` with
>    the store and `packetStore`; in `handlePeerConnected` call
>    `protocol.addPeer`, register `peer.onSync` → `protocol.handleSync`, and
>    **move the existing `peer.onRequest` handler into
>    `SyncProtocol.handleRequest`** (it should look blocks up in
>    `packetStore` and reply). Hook `onBlockReceived` to notify
>    `protocol.onBlockArrived`. Hook `handlePeerDisconnected` to
>    `protocol.removePeer`. Log decisions under a new `sync` scope via
>    `ctx.logger('sync')`.
> 5. Add `tests/network/sync_integration.test.ts`: two `Scaffold` instances
>    using `UnixSocketTransport`. Build divergent chains, connect, assert
>    both stores converge and canonical views match. Add a
>    peer-drops-mid-sync test.
>
> Constraints: Sync is separate from `FetchManager` — do not touch it. Do not
> change gossip. Do not change wire packets (`Sync`, `Request`, `Block`
> already exist in `Packet.ts`). Never silently drop errors: log a `warn` on
> unexpected peer input, `debug` on expected dedup. When you hit a gap,
> surface it per `AGENTS.md` "Never Hack Around Bugs" — do not paper over.
>
> Commit in logical chunks. Push to `claude/nifty-dijkstra-MR00C` when done.
