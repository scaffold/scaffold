# `fetch()` — Design

> Status: implemented (Phase 4) with two deferrals: `publish: false` throws
> `NotImplementedError`, and the trust gate is currently bypassed for
> streaming callbacks (only applies to `verify: true` callers). Both are
> tracked in [`TODO.md`](../../TODO.md). See [FetchManager.ts](../../src/node/FetchManager.ts).

`scaffold.fetch()` is the read-side entrypoint for Scaffold: "ask the network
to produce data matching this verifier, and tell me when (or if) someone
does." It is the mirror of `put()` and the main user-facing surface alongside
it.

---

## Scope

**In scope**
- Uniform entrypoint for request/response reads against the network.
- Contract-aware params encoding and response parsing (optional, opt-in).
- Two delivery modes determined by caller intent: a Promise (verified,
  immutable) or a streaming pair of callbacks (canonicality-tracking).
- Automatic deduplication of overlapping fetches against the same verifier.

**Out of scope (documented as future work at the end)**
- Local-only / cache-only lookups (no block-store-only mode).
- Sequenced "tracker" streams (tick-by-tick state listening). Covered by a
  sibling method built on top of `fetch()`.
- Explicit on-chain revocation of an unspent incentive.

---

## Core model

A fetch is a **subscription to results for a verifier**, implemented by
publishing an incentive output and observing blocks that claim it.

1. Caller supplies `{ contract, params, … }`.
2. Scaffold publishes an **incentive block** with one output
   `{ verifier: { contract, params }, value, data: empty }`. Gossip routes it
   to peers with claim history for that verifier (see
   [gossip.md](../protocol/gossip.md#claim-history-index)).
3. A **responder block** claims the incentive. Alongside that claim it
   produces one or more **self-claimed RECORD outputs** keyed by a record key
   (default: empty bytes). The record's `data` bytes are the result payload.
4. Multiple responders may race. One is canonical at any instant;
   canonicality transfers to another valid block as weight accumulates. If
   the canonical block is invalidated and no replacement exists, canonicality
   is lost.
5. The node surfaces canonical claims only after passing a **trust gate**:
   the block has been locally verified, or canonical collateral has been
   posted on it. Untrusted blocks are ingested and gossiped normally but do
   not drive fetch callbacks.

The "result" at the API level is the record's `data`. The "claim" is the
enclosing block plus its claim index. Callers choose which channel they want
to observe.

---

## Signature

```ts
interface FetchInput<T = unknown> {
  contract: Hash;
  params: Uint8Array | Record<string, unknown>;

  /** Which self-claimed record on the responder block to surface. */
  recordKey?: string | Uint8Array;       // default: empty bytes

  /** Verify the response contract locally before resolving. */
  verify?: boolean;                      // default false

  /**
   * When false, construct the incentive and any piggyback blocks
   * locally but do not broadcast them. The fetch still receives
   * callbacks for trusted claims the node observes on the network
   * (via piggyback). Zero on-chain participation from our side.
   */
  publish?: boolean;                     // default true

  /** Cancels subscription + releases observers (does not revoke incentive). */
  signal?: AbortSignal;

  /** Called once the incentive block is published. */
  onIncentive?: (block: Block, outputIdx: number) => void;

  /**
   * Called on each new canonical claim, including when the claim block
   * changes but the record data does not. `null` means the last-surfaced
   * claim was invalidated with no replacement.
   */
  onClaim?: (claim: FetchClaim<T> | null) => void;

  /**
   * Called when the surfaced record data changes. Does NOT fire when
   * canonicality transfers to a different block with the same data.
   * `null` means the last-surfaced result was invalidated with no
   * replacement. Only valid when verify !== true.
   */
  onResult?: (result: FetchResult<T> | null) => void;

  /**
   * Called for exceptional conditions: parse errors, verification
   * failures, no reachable peers, etc. Distinct from `null` callbacks,
   * which are part of the protocol's normal operation.
   */
  onError?: (err: Error) => void;
}

// verify:true  => Promise<FetchResult>   (stable, no flips)
// otherwise    => FetchHandle            (streaming; no one-shot sugar)
function fetch<T>(input: FetchInput<T> & { verify: true }): Promise<FetchResult<T>>;
function fetch<T>(input: FetchInput<T>): FetchHandle<T>;
```

```ts
interface FetchResult<T = unknown> {
  data: Uint8Array;

  /**
   * Run contract.walkData on `data` and return the walked value.
   * Memoized — repeated calls return the same Promise. Rejects with
   * SupersededError if a new result has arrived with different data,
   * with InvalidatedError if the result was invalidated, or with the
   * underlying error if walkData is unsupported or throws.
   */
  parse(): Promise<T>;
}

/** A claim surfaces the block that currently produces a result. */
interface FetchClaim<T = unknown> extends FetchResult<T> {
  block: Block;
  claimIdx: number;   // index into block.claims[] corresponding to our incentive
}

interface FetchHandle {
  close(): void;
}
```

### Why two callbacks

Canonicality flips and data changes are independent. A heavier block
claiming our incentive may surface the exact same record bytes as the
previous block — the claim moved but the result didn't. Most callers only
care about the result and shouldn't be re-notified on every claim flip
(which can be frequent for hot verifiers). The subset of callers who need
block-level info (auditing, provenance, collateral inspection) subscribe to
`onClaim`. The naming nudges general users toward `onResult`.

`FetchResult` intentionally does not expose the block. Callers who want a
block subscribe to `onClaim`. This prevents accidentally reading a block
that could later become uncanonical without the caller knowing.

### Null semantics

Canonicality **transfers**; it does not "go away." A heavier valid claim
replaces a lighter one by firing a new non-null callback, not via null.
`null` is fired on both channels only when the last-surfaced claim is
invalidated (for example, its collateral is slashed) and no other valid
claimant exists for the verifier.

### `parsed` rejection cases

- `SupersededError` — a different canonical claim surfaced different data.
- `InvalidatedError` — the surfacing claim was invalidated and no
  replacement exists.
- underlying error — the contract lacks `walkData`, or the walker threw.

All three flavors are catchable; callers that only care about the current
value can swallow the first two and continue.

### No `mode`

The caller's choice of consumption channel carries the semantic:

- `verify: true` → `Promise<FetchResult>`. Verified, immutable, one-shot.
- otherwise → `FetchHandle` with `onResult` / `onClaim`. Canonical, may
  flip.

No "streaming but only eventually-valid" case to cover. `mode` would add
configuration without adding capability.

### No `.result` convenience

Earlier drafts had `FetchHandle.result: Promise<FetchResult>` that resolved
on the first non-null `onResult`. Removed. It encouraged callers to treat a
non-verified fetch as a one-shot operation; the right way to get a
single-shot answer is `verify: true`, which honestly represents what the
caller wants (an immutable answer). Callers who truly want the first
canonical answer without verification can trivially build this on top of
`onResult` + `close()`, and doing so forces them to decide what to do if
that answer is later invalidated.

### `publish: false` — local-only machinery

> **Phase 4 status**: throws `NotImplementedError` at call time. The local
> piggyback mechanism it depends on is tracked in [`TODO.md`](../../TODO.md)
> under *Phase 4b*.

`publish: false` is "run the full fetch pipeline, but don't broadcast
anything." Every code path runs exactly as in `publish: true`:

- The incentive block is built and enqueued; `onIncentive` fires when
  it's ready. The only difference is it never hits the network.
- FetchManager registers the subscription.
- Piggyback runs normally: when a trusted satisfying block appears on
  the network, it constructs a piggyback block that refs the source,
  reproduces the record, and (locally) claims the unpublished
  incentive. `onClaim` and `onResult` fire with this piggyback.
- `verify`, `parse()`, dedup, and the trust gate all work identically.

The net effect is that we observe the V market without paying into it —
our local piggyback carries the record from whatever trusted source the
network produced. Useful when another party is already paying for
answers to V (shared oracles, popular state).

Implementation-wise, `publish: false` is just a flag at the network
boundary: we skip the broadcast. Everything else is the same. This
keeps the code uniform and avoids a second surfacing path.

`close()` deregisters the subscription; local blocks get garbage
collected. Nothing on-chain to worry about.

### No `anchor`

The incentive block uses the pending canonical tip like any other `put()`.

### No `value` on the call

Incentive amount is a node-level policy, not a per-call knob:

```ts
interface ScaffoldConfig {
  // ... existing fields
  getOutgoingIncentive?: (verifier: Verifier) => number;
}
```

Default (when unset): `0`. A zero-value incentive is still useful — gossip
routes it on claim history, and peers may answer out of self-interest.
Making it a config function means deduped callers never fight over value,
and we never silently drop a second caller's setting.

---

## Params: `Uint8Array | object`

Rule:

- `Uint8Array` → pass through.
- `object` → call `contract.buildParams(new DefaultBuilderHost(flatten(obj)))`
  to serialize. Reuses `src/core/DefaultBuilderHost.ts`.
- `object` supplied but the contract does not export `buildParams` → throw
  synchronously at the call site (fail loudly, not later).

Same decision for `recordKey`: accept `string | Uint8Array`. A string is
UTF-8 encoded to bytes. The default is empty bytes — tightest encoding,
zero ambiguity for single-record contracts (there is no "forgotten key"
interpretation), and contracts that expose multiple records use meaningful
string keys anyway.

---

## Response parsing

`FetchResult.parse()` runs `contract.walkData` on the record bytes (using
`RecordingWalkerHost`) and resolves to a normalized JS object. Think of it
as the counterpart to `Response.json()` in the browser `fetch` API.

- Lazy: no walker work happens unless the caller calls `parse()`.
- Memoized: repeated calls on the same `FetchResult` return the same
  Promise.
- Async because walker execution can be genuinely deferred: the claiming
  block may arrive before the responder contract's WASM has been fetched
  and compiled, and walker execution will run in a web worker
  (`src/worker/WorkerChannel.ts`).

The Promise's rejection cases — `SupersededError`, `InvalidatedError`,
underlying walker errors — are covered in the signature section above.

---

## Verify semantics

`verify: true` locally re-executes the responder contract against the
claiming block and its inputs. If the contract accepts, the fetch's Promise
resolves. Once resolved, the result is immutable — the contract's verdict
is deterministic given the block's fixed set of inputs, so there is no
canonicality channel to listen to.

Verification is **pure**: it proves "the response contract accepts this
block given the inputs the responder chose." It does not transitively
verify that the responder's referenced blocks (`block.refs`) are themselves
canonical or uncontested. A sufficiently buried invalid ancestor cannot be
caught here; that is a consensus-finality problem, not a
fetch-verification one.

Stronger finality (`waitForAnchorDepth`, `waitForWeight`) is future work.

---

## Incentive lifecycle

- **Publishing.** Enqueued on fetch call; `onIncentive` fires once the
  block is built and submitted. Enqueuing (not synchronous publish) leaves
  room for a future optimization that batches multiple incentives into a
  single block.
- **Receiving responses.** A reactive strategy watches canonicality +
  piggyback (see below) and delivers claims through the trust gate to
  subscribed callers.
- **`close()` / `signal`.** Stops the subscription, releases callbacks.
  **Does not revoke the on-chain incentive** — the output is published;
  reclaiming requires a block that consumes it. A future `revoke()` helper
  can add that; peers may also claim the incentive between close and
  revocation. Document clearly so callers don't expect refunds.

---

## Trust gate (node-wide policy)

Fetch does not surface a canonical block to callers until the node trusts
it. Trust = **locally verified** OR **canonical collateral posted on the
block**. Canonical + untrusted blocks are still ingested, indexed, and
gossiped; they simply don't drive user-visible fetch events or piggyback
copying.

This gate is not fetch-local. It lives above the block store and is shared
by any user-facing consumer (fetch, piggyback, collateral staking).

Consequences for fetch:

- An attacker publishing an uncollateralized invalid block cannot get
  honest nodes to amplify it — no piggyback, no fetch delivery.
- An attacker publishing a collateralized invalid block pays for the error
  when the deception layer catches it.
- Nodes that stake on a result they verified — and got wrong — lose the
  stake. That's the sampling/deception layer doing its job.

---

## Piggyback (implementation notes)

If the node sees a block satisfying our verifier that does **not** claim
our incentive, it can construct its own claiming block that references the
original and reproduces the record output. This is essential for network
health: it keeps old heavy computations valuable (they can be "re-sold" by
any node that stored them) and lets our own node claim back our incentive
before paying another fulfiller.

Flow, gated by the trust gate:

1. Observe a satisfying non-claiming block. If untrusted, ignore.
2. Build a piggyback block: anchors on our canonical tip, refs the
   original, produces the same record as a self-claimed output, claims our
   incentive. No collateral yet.
3. Surface the piggyback to fetch callbacks.
4. Locally run the responder contract against the piggyback (the `verify`
   path). If it accepts, optionally post our own collateral on the
   piggyback — this gives it canonicality weight and lets other peers
   trust it without re-verifying, making collateralized reselling a
   profitable service.
5. If local verification rejects, discard the piggyback and wait for a
   real responder. Our incentive is still open; no harm.

Piggyback also runs on incentives that haven't been published yet: we can
surface a trusted copy to the caller locally without ever broadcasting an
incentive. If a copy is available, we skip publishing.

Piggyback is a reactive strategy sibling to `FetchNotifyStrategy`, not
fetch-local logic.

---

## Dedup

Two `fetch()` calls with the same verifier share:

- **One incentive block / output.**
- **One subscription in the FetchManager.**

Each caller keeps its own projection over the subscription:

- Its own `recordKey` (different record readers off the same responder).
- Its own `verify` / `parse` flags.
- Its own `onResult` / `onClaim` / `onError` / Promise.

`close()` is refcounted — the underlying subscription drops only when the
last caller closes. The on-chain incentive block persists either way.

Dedup key: the verifier key, matching `FetchManager.verifierKey`.

---

## Examples

**One-shot verified read** (price oracle):
```ts
const r = await scaffold.fetch({
  contract: PriceOracle,
  params: { symbol: 'ETH' },
  verify: true,
});
const price = await r.parse();   // { usd: 3800 }
```

**Streaming canonical state** (live game tick):
```ts
const h = scaffold.fetch({
  contract: GameState,
  params: { room: 'r1', tick: 42 },
  recordKey: 'state',
  onResult: async r => {
    if (!r) return render('invalidated');
    try { render(await r.parse()); }
    catch (e) {
      if (e instanceof SupersededError) return;   // newer result on the way
      if (e instanceof InvalidatedError) return;  // onResult(null) will follow
      throw e;
    }
  },
});
// later: h.close();
```

**Block-level observer** (collateral / provenance auditing):
```ts
const h = scaffold.fetch({
  contract, params,
  onClaim: c => c && auditor.record(c.block.hash, c.claimIdx),
});
```

**Passive observation** (free answers from the V market):
```ts
const h = scaffold.fetch({
  contract: PriceOracle, params: { symbol: 'ETH' },
  publish: false,
  onResult: async r => r && display(await r.parse()),
});
```

**Raw bytes, no contract interpretation**:
```ts
const h = scaffold.fetch({
  contract, params: new Uint8Array(...),
  onResult: r => pushFrame(r?.data),
});
```

---

## Future work

- **Tracker** (`scaffold.track(...)`) — chained fetches driven by
  `nextParams(prev)` and a gate (timer, event). Thin wrapper; no new
  protocol machinery.
- **`revoke()` / explicit incentive reclaim** — publish a block that
  consumes our unspent incentive output back to a signature output we own.
- **`waitForAnchorDepth` / `waitForWeight`** — finality confidence beyond
  what local verification can provide.
- **Cache-only mode** — answer from the local block store without
  publishing an incentive.

---

## Open questions (for follow-up)

1. **Verification cost budgeting.** Local verification of a hard contract
   can be expensive. Should `verify: true` share work with the sampling
   module (which may already be verifying the block), or stay a standalone
   second pass? Current decision: standalone second pass for simplicity;
   revisit if verification cost becomes a bottleneck.
2. **Piggyback contract compatibility.** Piggyback relies on the responder
   contract accepting a claim from a block that only refs the original.
   True for pure record producers; false for contracts that assert the
   claiming block originated the work. Current policy: attempt, let local
   verification decide. Worth surfacing a contract-level hint if mis-gated
   piggybacks become common.
3. **`onError` scope.** What qualifies as "exceptional"? Parse failures
   and verification failures are clear; "no peers reachable" less so (it's
   arguably protocol-normal if we're offline). Current leaning: `onError`
   for programmable failures (parse, verify, walker), a separate status
   hook or logger for connectivity concerns.
4. **Trust gate re-enablement for streaming callbacks.** Currently, only
   `verify: true` callers are gated on trust. Streaming `onClaim` /
   `onResult` callbacks fire on canonicality alone because local
   verification fails on responses that use aggregate subtree outputs
   (`collectExtendedOutputs` in `src/core/Block.ts` does not walk
   aggregates — see `TODO.md`). Once the extended-vector construction
   is fixed, re-enable the trust gate in `FetchManager._reevaluate`.
