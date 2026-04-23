# Day-scoped plan: Cross-peer sync — orphan buffer + SyncProtocol wiring + two-node test

Date drafted: 2026-04-23
Target: ~1 working day, ~3 Claude sessions.
Ticks off part of **ROADMAP.md M1 (P2P Network, Apr 7 – May 9)**:

- [ ] Block fetching in SyncProtocol: recursive ancestor fetch, request batching, timeout/retry with peer rotation
- [ ] Integration tests: multi-node sync over WebSocket, browser-to-browser over WebRTC

Both M1 items stay open after the day; this plan lands the foundational
piece (orphan buffer + wiring + first two-node integration test) and
explicitly defers timeout/retry/rotation and WebSocket/WebRTC E2E tests to
follow-up days.

---

## 1. What I found (relevant state of the code)

- `src/node/SyncProtocol.ts` already exists: a tip-exchange class that
  sends `(tips, depth)` on connect and, on receipt of a peer's sync
  message, compares depth and calls `peer.requestBlocks(missingTips)`.
  It has 5 unit tests in `tests/SyncProtocol.test.ts`.
- **SyncProtocol is not wired into anything.** `grep -rn SyncProtocol
  src/` returns only its own file. `NetworkBridge.handlePeerConnected`
  registers handlers for `onRequest`, `onDelivery`, `onSignal`, but not
  `onSync`. It also never calls `initSync` after authenticating a peer.
- `NetworkBridge.handlePeerConnected.onRequest` is the only existing
  side of block-fetch: when a peer sends a Request packet, we look the
  hash up in `packetStore` and push the raw bytes back. No caller
  currently builds `Request` packets in production — only tests do.
- `Coordinator.blockReceived` inserts a block unconditionally
  (`store.put(block)` then `outputClaims.addBlock` then
  `consensus.addBlock`). There is **no** "anchor missing → defer"
  branch. `ConsensusModule.addBlock` walks the anchor chain via
  `provider.getBlock(current)` and simply stops the walk when a
  block isn't loaded (see `src/core/ConsensusModule.ts:158-171`). So
  out-of-order blocks are accepted, but the chain contributions and
  canonicality views are built as if the block is an orphan — it will
  stay non-canonical even after its anchor arrives, because the
  descendant's `chainContributions` was never registered against the
  anchor's key. **This is a latent bug if we enable recursive fetch
  naively.** See Open Question 3.
- Existing "real transport" tests: `UnixSocketTransport.test.ts` drives
  the plugin end-to-end (authenticated handshake, bidirectional
  bytes). `NetworkBridge.test.ts` uses `MockTransportPlugin`. There is
  no test that stands up two `Scaffold` instances and checks they
  converge.
- `docs/protocol/routing.md:212-220` specifies a
  `fetch(hash): Promise<Block>` interface — not implemented. Sampling
  is the named consumer but is also not wired through it yet.

Confirmed: the SyncProtocol tip-exchange is the simplest possible
protocol (tip + depth). It does **not** walk the anchor chain, so even
once wired up it only catches the common case "peer has 1 block I'm
missing and that block's anchor I already have." The real M1 item —
recursive ancestor fetch — is the next layer of work.

---

## 2. Daily goal

> A fresh `Scaffold` instance connecting to a running instance catches
> up all missing blocks and converges to the same canonical view,
> proven by a Deno test that runs two Scaffolds over
> `UnixSocketTransport`.

Specifically:

1. **Orphan buffer** lives between the network and the coordinator.
   When the bridge receives a block whose anchor is not yet in the
   store, the block is buffered and the bridge issues a `Request` for
   the missing anchor(s). When the anchor arrives, the buffered
   descendant is re-fed into the processing pipeline.
2. **SyncProtocol wired** into `NetworkBridge.handlePeerConnected` —
   `initSync` is called once the authenticated channel is live, and
   `onSync` is routed to `SyncProtocol.handleSync`.
3. **Integration test**: two Scaffolds, A publishes 3+ chained blocks,
   B connects, B converges.
4. **Design doc** (`docs/design/sync.md`) capturing the protocol
   shape — including what this day does **not** do (timeout,
   retry, peer rotation, large-gap range sync). Cross-linked from
   `src/node/SyncProtocol.ts` and listed in `AGENTS.md`'s source↔doc
   map.

Out of scope for the day:

- Per-request timeouts, retry policy, peer rotation on stall.
- Range/bisection sync for large chain gaps (current protocol is
  O(gap) recursive requests).
- Parallel fetch from multiple peers for redundancy.
- WebSocket or WebRTC plugins in the integration test — the Unix
  transport is sufficient to prove the wiring works end-to-end.
- Set reconciliation / HashAnnounce inventory (future).

---

## 3. Work breakdown (per Claude session)

### Session 1 — Design doc + orphan buffer skeleton

Expected outcome: `docs/design/sync.md` committed, `OrphanBuffer` class
skeleton added with unit test stubs that all currently `assert(false)`
or `ignore: true`.

1. Draft `docs/design/sync.md`:
   - Lifecycle: anonymous connection → authenticated handshake →
     `SyncProtocol.initSync(peer)` → exchange → recursive request
     loop until orphan buffer empty for this peer.
   - Orphan buffer semantics: (a) deduplicate by hash; (b) insert on
     "anchor not in store" at bridge-receive time; (c) drain when an
     ancestor is processed; (d) dropped entirely when the peer
     disconnects, since the decision to fetch depended on that peer.
   - "Recursive ancestor fetch" = if a requested block's anchor is
     also missing after processing, issue a new Request. Bounded in
     depth only by chain depth; no explicit cap for this day.
   - Explicit non-goals for first implementation: timeout/retry,
     peer rotation, parallel fan-out.
   - Interaction with `ConsensusModule.addBlock`'s chain-contribution
     walk (see Open Question 3).
2. Add `// Protocol spec:` comment to `src/node/SyncProtocol.ts`
   pointing at the new design doc.
3. Add a `docs/design/sync.md` row to the `AGENTS.md` source↔doc map.
4. Create `src/node/OrphanBuffer.ts` with:
   - `insert(block: Block): void`
   - `drain(hash: Hash): Block[]`  — returns blocks whose anchor was
     `hash` (and drains them)
   - `has(hash: Hash): boolean`
   - `removeForPeer(peerId: string): void` (see Open Question 2)
5. Create `tests/OrphanBuffer.test.ts` with state-transition tests
   covering the above API (AGENTS.md: tests as spec).

### Session 2 — Wire orphan buffer + SyncProtocol into NetworkBridge

Expected outcome: bridge triggers sync on connect, buffers orphans,
drains when ancestors arrive. Existing tests still green; new
`NetworkBridge` tests for orphan flow pass.

1. Implement `OrphanBuffer` fully; all tests green.
2. In `NetworkBridge.handlePeerConnected`:
   - Construct a `SyncProtocol` instance (one per bridge, not per
     peer — it's stateless aside from store access). Store it as a
     private field in the bridge.
   - Call `syncProtocol.initSync(peer)` right after the per-peer
     handlers are wired.
   - Wire `peer.onSync(data => syncProtocol.handleSync(peer, data.tips,
     data.depth))`.
3. Intercept `onBlockReceived` in the bridge (before calling
   `deps.processBlock`):
   - If `store.has(block.anchor)` or `block.anchor === ZERO_HASH` →
     process normally, then call
     `orphanBuffer.drain(block.hash)` and re-process each drained
     block recursively.
   - Else → `orphanBuffer.insert(block)` and
     `peer.requestBlocks([block.anchor])`.
4. Wire `onPeerDisconnected` to call
   `orphanBuffer.removeForPeer(peerId)` (see Open Question 2).
5. Extend `tests/NetworkBridge.test.ts` with two cases:
   - inbound block with missing anchor is buffered and a Request for
     the anchor is sent;
   - when the anchor subsequently arrives, both blocks end up
     processed in order (anchor first, descendant second).

### Session 3 — Two-node Scaffold integration test

Expected outcome: `tests/integration/twoNodeSync.test.ts` green.

1. Create `tests/integration/` directory (empty today — consistent with
   the flat test layout elsewhere, but this warrants a subdir since
   it spins up full stacks).
2. Write `twoNodeSync.test.ts`:
   - Instantiate two `Scaffold` instances with
     `UnixSocketTransport` plugins (use `needsUnix` ignore guard like
     `UnixSocketTransport.test.ts`).
   - `scaffoldA.put({...})` three times to produce a chain.
   - `scaffoldB.bootstrapConnection('unix', <A's address>)` then
     `scaffoldB.connectToPeer(scaffoldA.publicKey)`.
   - `waitFor(() => scaffoldB.blocks.has(aTipHash))` with a reasonable
     timeout (e.g. 2s).
3. When the test surfaces bugs — as it will, in at least one of
   (packet order, genesis expectation, chain-contributions walk,
   gossip suppression of "already-sent") — stop and flag per
   AGENTS.md. Do **not** weaken the assertion.
4. Commit + push. Update `TODO.md` with any new gaps discovered.

---

## 4. Open questions for Joel

I lean toward the answers below but want your sign-off before
one-shotting.

### Q1. Orphan buffer location: `NetworkBridge` vs new `SyncOrchestrator` class?

- **In-bridge** is 30 lines of code. Bridge already owns peer
  lifecycle, packet store, and processBlock dispatch.
- **Separate `SyncOrchestrator`** is cleaner if session-2's "recursive
  request" logic grows (timeouts, retries, peer-rotation,
  request coalescing across peers). M1 eventually needs all of that.
- **My recommendation**: separate class from the start
  (`src/node/SyncOrchestrator.ts`), owning `OrphanBuffer` +
  `SyncProtocol` + the request dispatcher. Bridge delegates inbound
  blocks to it. Keeps the timeout/retry expansion in one place.

### Q2. Orphan buffer peer-attribution

If B receives an orphan block from peer P and then P disconnects before
delivering the anchor, what do we do?

- Option A: drop all orphans that came from P (clean, risks losing
  data we'll receive from another peer anyway).
- Option B: keep orphans, re-issue requests to some other peer that
  claims the same chain tip (requires knowing which peers have what).
- Option C: just keep them indefinitely and rely on gossip to
  eventually deliver.

**My recommendation for today**: Option A. Deferring B/C to the
timeout/retry session. The integration test uses only two peers so
this won't fire.

### Q3. `ConsensusModule.addBlock` chain-contributions walk

When we receive a descendant before its anchor, the descendant's
`addBlock` walks the chain via `provider.getBlock(current)` and stops
when the anchor isn't loaded (line 168: `if (!cBlock) break`). This
means the descendant never registers a chain contribution against the
eventual ancestor, so weight aggregation up the chain is wrong forever.

With the orphan buffer in place, we won't call `addBlock` on a block
whose anchor isn't loaded. But this is a latent bug waiting for any
future path that processes out-of-order blocks. Two options:

- **Today's plan (fine)**: orphan buffer prevents this case. Add a
  TODO.md entry noting the latent bug.
- **Belt-and-suspenders**: also fix `ConsensusModule.addBlock` to
  re-walk (or repair) chain contributions when a previously-unknown
  ancestor is added.

**My recommendation**: today, just the orphan buffer. File the
contributions-walk issue in `TODO.md`. If the integration test
surfaces weight anomalies, we revisit; unlikely since A publishes a
clean chain and B processes in-order once ancestors arrive.

### Q4. `SyncProtocol` tip set — already-have filter at the sender

`SyncProtocol.handleSync` filters remote tips against our store
(`this.store.has(hash)`). Good. But it does not currently follow up
the anchor chain — so if A has a 5-block chain whose tip we don't have,
we ask for the tip; that tip arrives with an unknown anchor; orphan
buffer kicks in and asks for the anchor; recursion continues. That's
recursive ancestor fetch, session-2 style. Confirm that's the shape
you want rather than having `SyncProtocol.handleSync` itself fetch
ancestors eagerly. (I think reactive is right — fewer wire messages
when the chain fork point is shallow.)

---

## 5. One-shot prompt for Claude (only once Q1–Q4 are answered)

Draft below. I'd tweak after your answers; leaving it here so you can
see the shape.

```
We're implementing the first slice of roadmap M1's "Block fetching in
SyncProtocol" item. Full plan and context in
docs/plans/sync-orchestrator-day.md.

Goals for this session: (A) write docs/design/sync.md per section 3
Session 1 of the plan; (B) add src/node/OrphanBuffer.ts with full
implementation plus tests/OrphanBuffer.test.ts; (C) wire both the
orphan buffer and SyncProtocol into NetworkBridge per section 3
Session 2 of the plan; (D) add regression tests to
tests/NetworkBridge.test.ts for the orphan buffer flow.

Joel already decided:
- Orphan buffer lives inside a new SyncOrchestrator class at
  src/node/SyncOrchestrator.ts (not inside NetworkBridge directly).
- On peer disconnect, drop all orphans received from that peer.
- Don't modify ConsensusModule today; log the latent
  chain-contributions walk bug into TODO.md.
- SyncProtocol keeps its current tip-only exchange; recursive fetch
  happens reactively via the orphan buffer (no ancestor-walk in
  SyncProtocol itself).

Follow AGENTS.md: protocol-as-source-of-truth, never work around
bugs, update TODO.md with anything surprising. Commit the work on
branch claude/nifty-dijkstra-o8jkR.

Do NOT write the two-node integration test in this session; that's
a separate follow-up. Stop and ask if the NetworkBridge wiring
surfaces anything that needs a call.
```

Then a second prompt for Session 3 (two-node integration test) once
the wiring is green.

---

## 6. Risk / rollback notes

- Risk: NetworkBridge today pushes gossip on receive. With an
  orphan buffer, we delay processing → delay gossip → a peer might
  not learn we have the block until the anchor arrives. Fine for
  M1; document in the design doc.
- Risk: current `SyncProtocol.handleSync` returns `Hash[]` that is
  unused by callers (caller just fires the request side-effect).
  That's OK, but we should double-check the return value isn't load-
  bearing in any follow-up tests.
- Rollback: each of the three chunks is independently revertable.
  Session 1 is additive (new doc + new file). Session 2 changes
  bridge behavior — if it breaks anything, revert and keep OrphanBuffer
  unused on disk. Session 3 is a new test file.
