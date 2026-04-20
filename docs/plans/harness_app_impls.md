# Plan: Wire harness behaviors to real `scaffold.put()` / `scaffold.fetch()`

Context handoff. The harness runs end-to-end (see `docs/harness/`), the
analyzer classifies metrics against thresholds, but the four v1
behaviors (`social_media`, `money_send`, `aggregator`, `validator`)
only emit `kind=app` intent events today. They never call
`scaffold.put()` or `scaffold.fetch()`, so the block-flow metrics
(`block_propagation_ms`, `blocks_per_sec_per_session`,
`contracts_per_sec_per_session`, `req_reply_latency_ms`,
`fetch_unanswered_pct`, `balance_delta_per_session`) all report
`count=0` / "not classified" on the committed evaluation run at
`harness/metrics/evaluation.json`.

This plan captures what a new context window needs to do to light
those metrics up.

## Current state, tersely

- Every `runApplication` call constructs a `Scaffold` with
  `privateKey`, deterministic `genesis` from the keypool, a
  `LatencyTransport` wrapping `UnixSocketTransport`, and
  `enableLogging: false`.
- Behaviors receive `AppContext.scaffold` but none of them call put /
  fetch / connectToPeer today.
- Genesis gives each user with `balance > 0` a **Signature output**
  (`makeSignatureOutput(pubkey, balance)`). Zero-balance users own
  nothing initially.
- The analyzer's metric queries are already wired to recognize
  `send_intent` / `reply` / `balance_change` app events and
  scaffold-emitted `blockReceived` events. You do not need to change
  metric-compute SQL; you just need the behaviors to cause these
  events to flow.

## Key Scaffold API surface

All in `src/Scaffold.ts` + `src/node/PutManager.ts`:

```ts
scaffold.put({ outputs: Output[], claims?: { index: number; value: number }[] })
  -> PutResult { hash: Hash }

scaffold.fetch(verifier: { contractHash: Hash; params: Uint8Array },
               { onResult: (r: { block, data, value }) => void })
  -> FetchHandle

scaffold.registerContract(hash: Hash, contract: Contract): void

scaffold.blocks  // reactive BlockRecordSet -- onAdd, onRemove
scaffold.eventLog.onAppend(cb)  // already used by App.ts
scaffold.connectToPeer(remotePubkey: Uint8Array)
scaffold.onPeerConnected / onPeerDisconnected
```

The auto-balancer inside `NodeContext.createBlock` handles claim
computation: pass only `outputs`, and Scaffold fills claims from the
caller's UTXO set keyed by verifier. Claims the caller passes
explicitly are respected. See the `autoBalance` comment in
`MEMORY.md` / `Scaffold.ts:processor.buildBlock`.

Helpful contracts already implemented:

- `makeSignatureOutput(publicKey, value)` in
  `src/contracts/SignatureContract.ts` — pubkey goes in
  `verifier.params`.
- `HelloContract` in `src/contracts/HelloContract.ts` — worked example
  of a fetchable request/reply contract (`scripts/demo_node.ts` shows
  the full flow: publish HELLO request with `scaffold.put`, capability
  holder publishes reply, requester reads via `scaffold.fetch`).
- `AggregationContract`, `CollateralContract`, `RecordContract` —
  handled by Scaffold automatically; behaviors rarely need to touch
  them directly.

Demo patterns to mine:

- `scripts/demo_node.ts` — end-to-end request/reply over WebSocket,
  shows `scaffold.put({outputs: [makeHelloRequest(name, 1_000_000)],
  claims: [{ index: 0, value: 1_000_000 }]})` and `scaffold.fetch({...},
  { onResult })`.
- `src/demo/DemoNode.ts` / `StatusContract.ts` — signed-status
  publishing + subscription indexed by user.

## Per-behavior implementation

### money_send

**Goal:** produce real on-chain transfers so
`balance_delta_per_session` and block-flow metrics populate.

**Loop:**

1. On spawn, check `ctx.scaffold` UTXO state for this user's
   signature outputs (the user's genesis output, or outputs received
   from prior transfers). If none and session is new → skip or wait.
2. Each tick (every `sendIntervalMs`), pick a random peer from
   `ctx.directory.snapshot()`, pick a random amount in `params.amount`,
   call `scaffold.put({ outputs: [makeSignatureOutput(destPubkey,
   amount)] })`. Auto-balance will claim the sender's UTXOs and
   produce a change output.
3. Emit:
   - `send_intent { requestId, destination, contract: SIGNATURE_CONTRACT_HEX, amount }` at put call time.
   - `balance_change { amount: -amount, contract: SIGNATURE_CONTRACT_HEX }` at put call time.
4. `requestId` is the resulting `putResult.hash.toHex()` — use the
   block hash as the correlation key.

**Receiver side** — receiver is another money_send session. How does
it emit the matching `reply` and `balance_change`? Easiest:

- Every money_send session subscribes via `scaffold.blocks.onAdd` to
  its own blocks. When an incoming canonical block contains a
  signature output whose params match this user's pubkey, emit:
  - `reply { requestId: block.hash.toHex() }`
  - `balance_change { amount: +value, contract: SIGNATURE_CONTRACT_HEX }`

This gives both request/reply latency (sender's `send_intent` at put
time vs receiver's `reply` at canonical-arrival time) and
balance-delta in both directions.

**Gotchas:**

- Users with `balance=0` can receive but can't initiate transfers
  until they've received something. Either start only users with
  balance>0 as money_send, or have the behavior skip sends until
  balance is positive.
- `scaffold.put` may fail if there are no claimable UTXOs. Wrap in
  try/catch and emit `send_failed` for observability.
- When behavior exits via SIGKILL mid-put, the resulting block may
  already be on the wire. That's the intended "silent leave"
  evidence the `packets_without_recv.sql` query looks for.

### social_media

**Goal:** light up `req_reply_latency_ms`, `fetch_unanswered_pct`,
and `block_propagation_ms`.

**Simplest framing — use SignatureContract as a "post":** each user's
latest signed Signature output with non-empty `data` is their "latest
post." Followers fetch that. Posting = `scaffold.put({ outputs:
[makeSignatureOutput(myPubkey, 1).withData(encode(postContent)) ] })`.

Alternative: introduce a `PostContract` with `params = authorPubkey`,
`data = post content`. Probably overkill for v1 — just use
SignatureContract with a zero or token-value output whose data field
carries the post.

**Loop:**

1. On spawn, some fraction of sessions publish posts at random
   intervals (say 10% of sessions; configurable via `params.postRate`).
   Posting = `scaffold.put(...)`.
2. All sessions scroll a feed: pick a random peer from
   `ctx.directory.snapshot()`, call `scaffold.fetch({ contractHash:
   SIGNATURE_CONTRACT, params: peer.pubkeyBytes }, { onResult })`.
   Emit `send_intent { requestId: fetchId, destination:
   peer.pubkeyHex, contract: SIGNATURE_CONTRACT_HEX }` when the fetch
   starts; emit `reply { requestId: fetchId }` in `onResult`.
3. `fetchId` = `${sessionId}:${scroll}` or a uuid. Track open fetches
   so we can emit `fetch_timeout` events for ones that never
   resolve within the session.
4. Peer migration: `peerMigrationRate` chance per scroll; switch
   `followed` peer. Call `scaffold.disconnectPeer(oldPeerId)` and
   `scaffold.connectToPeer(newPubkey)` to exercise the real
   peer-migration code path.

**Gotchas:**

- `scaffold.fetch` subscribes and fires `onResult` whenever the
  canonical answer changes. For one-shot req/reply you want to
  unsubscribe after the first result. The `FetchHandle` has an unsub
  method (check `FetchManager.ts`).
- Fetching a pubkey with no recent post returns no result. Track
  `unanswered = started - resolved` at session end; emit
  `fetch_session_summary { started, resolved }` so the analyzer can
  compute `fetch_unanswered_pct` per session.

### validator

**Goal:** participate in verification so `contracts_per_sec_per_session`
populates; exercise `enableVerification` properly.

**Loop:**

1. At construction time, override `enableVerification` in the Scaffold
   config to return true for the contract hashes we care about
   (`SIGNATURE_CONTRACT`, `AGGREGATION_CONTRACT`, maybe
   `COLLATERAL_CONTRACT`).
2. Watch `scaffold.eventLog.onAppend` for `system: 'execution'` entries
   (`contractVerified`, `contractFailed`) and emit behavior summaries.
3. Future: call `scaffold.put({outputs: [makeCollateralOutput('FOR',
   ...)]})` when verification succeeds — but this is deferred until
   the collateral posting strategy (see `TODO.md` Core Protocol
   section) exists.

**Gotcha:** `enableVerification` is a function passed in the
`ScaffoldConfig`, not a runtime toggle. Needs to be decided at
session construction. App.ts currently doesn't read a
`verifyContracts` param — add one to `AppContext`/params and thread
through.

### aggregator

**Goal:** keep as a long-lived backbone participant. Aggregation
block creation is driven by Scaffold's reactive layer automatically
when an aggregation threshold is reached; aggregator doesn't need to
call `put` directly. The behavior mainly ensures there are
long-running nodes to produce aggregation outputs.

**Minimal change:** none beyond current heartbeat. Aggregation metric
breakdowns (aggregations per minute, etc.) can be added later by
watching `scaffold.blocks.onAdd` for blocks whose outputs contain
`AGGREGATION_CONTRACT`-verified entries.

## Cross-cutting changes in `App.ts`

Threading work:

- Expose a `makePost` / `sendTransfer` convenience on `AppContext` so
  behaviors don't repeat `put` boilerplate.
- Add a helper `ctx.observeMyIncomingTransfers(cb)` that subscribes
  via `scaffold.blocks.onAdd` and filters for new signature outputs
  with `verifier.params === myPubkey`. Used by money_send.
- Emit `balance_change` from that helper automatically, so behaviors
  just need `ctx.sendTransfer(dest, amount)` and the helper handles
  both the send and the per-side emissions.

```ts
// Sketch in harness/applications/App.ts
ctx.sendTransfer = async (destPubkey: Uint8Array, amount: number) => {
  const hash = scaffold.put({ outputs: [makeSignatureOutput(destPubkey, amount)] }).hash;
  const requestId = hash.toHex();
  emitApp('send_intent', { requestId, destination: bin2hex(destPubkey),
                           contract: SIGNATURE_CONTRACT.toHex(), amount });
  emitApp('balance_change', { amount: -amount,
                              contract: SIGNATURE_CONTRACT.toHex() });
  return hash;
};

ctx.observeMyIncomingTransfers = () => {
  scaffold.blocks.onAdd((block) => {
    for (const output of block.outputs) {
      if (output.verifier.contract.equals(SIGNATURE_CONTRACT) &&
          bytesEqual(output.verifier.params, myPubkey)) {
        emitApp('reply', { requestId: block.hash.toHex() });
        emitApp('balance_change', { amount: +output.value,
                                    contract: SIGNATURE_CONTRACT.toHex() });
      }
    }
  });
};
```

## Suggested sequencing

1. **App.ts helpers** (`sendTransfer`, `observeMyIncomingTransfers`,
   `fetch` helper for social_media). Land behind a simple unit test
   in tests/.
2. **money_send wired.** Run `harness/configs/smoke.yaml`; assert
   `balance_delta_per_session` and `req_reply_latency_ms` populate
   (low sample counts are OK for smoke). Commit an interim
   evaluation.json.
3. **social_media wired.** Handle fetch-handle cleanup carefully to
   avoid leaks across 100+ sessions; reuse behaviors/social_media.ts
   Params interface. Re-run evaluation; commit.
4. **validator enableVerification.** Add `verifyContracts` param,
   thread through ScaffoldConfig. Light test; commit.
5. **aggregator observability.** Optional, lowest priority.

After each step, re-run:

```sh
deno run --allow-all harness/coordinator.ts harness/configs/evaluation.yaml
deno run --allow-all harness/observer.ts ./runs <run-id> <pg-url>
deno run --allow-all harness/analysis/analyzer.ts <run-id>
```

and commit `harness/metrics/evaluation.{json,txt}` with a one-liner
explaining the expected metric movement.

## Threshold tuning to expect

Current `harness/analysis/thresholds.yaml` was calibrated against
"never happened" metrics. Real numbers will almost certainly miss
many passes initially:

- `req_reply_latency_ms` p99 pass=500 fail=3000 — realistic for in-
  process Unix sockets, but depends on how many rounds of gossip it
  takes for a fetch to resolve. Expect initial p99 to be 1-3 seconds.
- `fetch_unanswered_pct` pass=0.02 fail=0.30 — depends on feed peer
  having posts; if social_media only 10% of sessions post, fetches
  from the other 90% will all be unanswered.
- `balance_delta_per_session` — thresholds at 0 vs -100 are fine for
  directionality but `buffer` will be null; consider nonzero pass
  like pass=-10 fail=-200 once you see real numbers.
- `clean_exit_pct` — current threshold pass=0.95 is impossible with
  `run.force_close_rate=0.2`. Either raise pass to 0.8 and fail to
  0.5, or lower `force_close_rate` in the evaluation config. I'd
  lower the rate; force-close rate should be the churn knob, not a
  baked-in chunk.

Expect the first "real" evaluation commit to show a drop in the
summary count (more WARN/FAIL appear because more metrics have
data to classify).

## Known gotchas / pitfalls

- **Contract registration is local.** Every node needs `registerContract`
  calls for any custom contract it will generate or verify. Scaffold
  falls back gracefully for non-executable contracts (Signature) but
  not for custom ones. HelloContract requires `registerContract` on
  both requester and responder nodes.
- **Fetch semantics are subscription, not req/reply.** `onResult`
  fires on every canonical change for that verifier. To simulate
  req/reply, unsubscribe after the first valid result.
- **Auto-balance needs UTXOs indexed.** UtxoIndex is wired via
  `onCanonicalityChange`; it's populated as blocks become canonical.
  On a cold-start node with only genesis, UTXOs for a user are only
  the genesis signature output until new canonical blocks arrive.
  Calling `scaffold.put` immediately after startup might see no
  UTXOs if the session started before the genesis propagation (which
  is instant — genesis is in the config). This edge case probably
  doesn't matter but watch for "no UTXOs" warnings.
- **Session scope for `ctx.observeMyIncomingTransfers`.** If a
  session is SIGKILL'd mid-subscription, the callback stops firing.
  That's fine; the observer still captured whatever emissions
  happened before the kill.
- **Anchor / aggregator contracts.** Anchors are configured
  `is_anchor: true` and never send their own transfers. They should
  still `observeMyIncomingTransfers` so that if they happen to
  receive a test transfer (rare), it's captured.

## Useful pointers

| What                      | Where                                      |
|---------------------------|--------------------------------------------|
| PutRequest / auto-balance | `src/node/PutManager.ts`, `src/Scaffold.ts` |
| Signature output helper   | `src/contracts/SignatureContract.ts`       |
| Fetch handle lifecycle    | `src/node/FetchManager.ts`                 |
| Canonical block events    | `src/reactive/BlockRecordSet.ts`, `src/node/ConsensusModule.ts` |
| HelloContract example     | `src/contracts/HelloContract.ts`, `scripts/demo_node.ts` |
| StatusContract pattern    | `src/demo/StatusContract.ts`, `src/demo/DemoNode.ts` |
| UtxoIndex + auto-balance  | `src/node/UtxoIndex.ts`, `src/Scaffold.ts:autoBalance` comment |
| Analyzer metric SQL       | `harness/analysis/metrics/*.ts`            |
| App.ts runtime            | `harness/applications/App.ts`              |

## Don't-forget list

- Update `harness/analysis/thresholds.yaml` after the first real run
  so `clean_exit_pct` and `balance_delta_per_session` are reachable.
- Consider lowering `evaluation.yaml`'s `force_close_rate` from 0.2
  to 0.05 once real traffic is flowing, so churn doesn't dominate
  the metrics.
- Re-run the evaluation and commit the `harness/metrics/evaluation.{json,txt}`
  diff with a descriptive message ("evaluation: money_send transfers
  wired; p99 latency 1.2s → see req_reply_latency buckets").
- When you wire behaviors to Scaffold, existing scaffold tests in
  `tests/` should keep passing; `deno task test` covers the whole
  suite, currently 929 tests.
