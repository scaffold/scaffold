# Piggyback — Design

> Status: implemented (Phase 3). Universal-piggyback variant; the
> earlier fetch-subscription-scoped design has been superseded.
> Depends on the [trust gate](trust-gate.md).

## Problem

Fetch's incentive model works in the common case: I publish an output
paying for verifier V, a responder claims it and posts a record, I see the
record. But two failure modes waste money and undermine the network's
long-term value:

1. **Duplicate work.** Alice and Bob both want the answer to V. Alice
   publishes first, Carol answers Alice. Bob now wants the same answer but
   has a fresh incentive out — Bob pays twice for the same work.
2. **Dead computation.** Carol spent real CPU producing the answer to V.
   Once her block is old, no one can spend it again. Heavy computations
   should be *reusable* — otherwise the only rational strategy is "answer
   once, discard, never cache," which is bad for the network.

Piggyback fixes both by turning every node into a competitive responder.
When the node sees a trusted block containing the answer to V and a
canonical unspent incentive for V exists in the network (whether ours or
anyone else's), it **builds its own claiming block** that references the
source, reproduces the record, and claims that incentive. No new
responder work, no duplicate payment, and the original responder's old
block stays economically alive as a source.

---

## Core flow

Triggered for every {canonical unspent output O with verifier V, trusted
block B that already serves V but does not claim O}. Three event sources
funnel into the same loop:

- **New trusted block.** A block becomes `Trusted` (verified or
  collateralized). Scan its resolved claims to discover which verifiers
  V it serves; for each V, look up unspent canonical UTXOs in the index.
- **New unspent UTXO.** A canonical UTXO with verifier V appears (e.g.
  via reorg). Look up trusted sources for V from the inverted index.
- **New claim resolution.** OutputClaimService delivers a resolution
  for an already-trusted block; treat as the "new trusted block" path.

```
For each (V, B, O) tuple matched above:

  1. Skip if (V, B, O) was already attempted.
  2. Skip if O is the same output B already claims (B == responder).
  3. Construct a piggyback block:
       anchor:  our canonical tip
       refs:    [B]
       outputs: [copies of B's self-claimed RECORD outputs]
       claims:  [self-claim of each copied record, claim of O]
       declaredWeight: 0
       aggregates: []
  4. Locally ingest the piggyback (broadcast: false). Force
     verification via BlockVerificationService.verify(piggybackHash).
  5. On verify pass:  dispatch submitBlock -> network broadcast.
       (Optional: separately post FOR collateral on the piggyback as
       a node-policy decision; deferred to a later phase.)
     On verify fail: discard; reopen the (V, B, O) attempt slot so a
       different source can be tried later.
```

Piggyback is **not scoped to the node's own fetch subscriptions**. Any
open V request in the network is fair game once we have a trusted answer
for V — this is what makes piggyback the competitive-responder market.

---

## Why no collateral up-front?

The source block is trusted. We're reproducing its record. If our local
verification accepts, the piggyback is computationally valid *to us*. But
we're not required to stake on it to surface it — the trust gate already
decided. Collateral is a separate economic decision:

- Stake → our piggyback becomes a trust signal for other peers; they'll
  surface and piggyback it without verifying. If we're wrong, we lose the
  stake.
- Don't stake → our piggyback works for us and anyone who verifies it
  locally, but not as a trust signal.

Both are valid. Defer the policy to node config.

---

## Local-only piggyback (pre-publish and `publish: false`)

Two cases produce a piggyback that is constructed locally and **never
broadcast**:

1. **Pre-publish.** Our incentive for V is still enqueued (not yet
   broadcast) when a trusted satisfying block appears. We build the
   piggyback locally, surface the record to callbacks, and cancel the
   pending incentive publication — we never pay anyone. For popular
   verifiers (shared oracles, widely-requested state), this should be
   the common case.

2. **`publish: false`.** The caller asked for local-only operation. The
   incentive is constructed but never broadcast; piggyback runs
   normally against trusted network blocks and constructs local
   piggybacks that locally claim the unpublished incentive. Everything
   surfaces through the same `onClaim` / `onResult` paths.

In both cases, the local piggyback block is not ingested into the block
store and never touches the network. It exists as a well-formed
`FetchClaim.block` carrying the record via `refs`, so that the fetch
callback surface stays uniform across published and local-only
execution. Piggyback treats broadcasting as a flag at the network
boundary, not a separate code path.

---

## Race with real responders

After we broadcast a published-incentive piggyback:

- If the original responder broadcasts first: our claim never lands, our
  incentive is gone to them. This is fine — we wanted the record, we got
  it.
- If we broadcast first: original responder may still claim, and now two
  blocks conflict on the same incentive output. Consensus resolves via
  weight. We have no collateral; they might. If they have collateral, they
  win and we lose. If neither has collateral, it's a weight tiebreak.

In the lose case, we still had the record (surfaced to the caller from
step 3a) — the only thing we lost is the incentive-reclaim optimization.
No harm to the fetch API semantics.

---

## Contract compatibility

Piggyback only works when the response contract's `run()` accepts a block
that:
- refs the original computation
- reproduces the record output
- claims our incentive
- was authored by us (not the original responder)

True for pure record-producing contracts (game ticks, price oracles,
computation results). False for contracts that assert something like "the
claiming block must contain the original computation inline." 

Policy: **attempt and let local verification decide**. No contract-level
flag. If verify rejects, discard silently — a real responder will come
along. If piggyback failures become common for a particular contract,
surface as a log/metric and revisit.

---

## Interaction with dedup

Multiple fetches against the same verifier are deduped at FetchManager
level (one incentive, one subscription). Piggyback operates per
subscription, so each verifier gets at most one piggyback attempt per
source block. Different record keys against the same verifier share the
same piggyback construction — one piggyback block can carry multiple
record outputs.

---

## Source selection

If multiple trusted blocks satisfy V, which one do we piggyback from?

- **Canonical heaviest** is the natural choice: canonical > non-canonical
  (the record is the current truth), heavier > lighter (more stable).
- **First seen** is simpler and avoids recomputation when canonicality
  flips, but risks piggybacking from a lighter block that's about to lose
  canonicality.

Start with canonical heaviest. Re-evaluate if canonicality flipping
causes too much piggyback churn.

---

## Interface sketch

```ts
// Reactive strategy. Wired in NodeContext alongside DraftStrategy and
// any user-supplied strategies.
class PiggybackStrategy implements Strategy {
  constructor(deps: {
    trustGate: TrustGate;
    blockVerification: BlockVerificationService;
    blockStore: BlockStore;
    consensus: ConsensusService;
    utxoIndex: UtxoIndex;
    outputClaims: OutputClaimService;
    dispatcher: { dispatchActions(a: Action[]): void };
    outputSpace: () => OutputSpaceModule;
    logger?: ScopedLogger;
  });

  evaluate(event: ReactiveEvent): Action[];
}
```

Emits `createBlock { broadcast: false }` (locally-ingested piggyback) and
`submitBlock { hash }` (graduate to network broadcast after local
verification passes). Both action types live on `ReactiveLayer.Action`.

---

## Open questions

1. **Bounded piggyback attempts.** A popular verifier might have many
   trusted sources. Currently the strategy attempts piggyback against
   every trusted source for every unspent UTXO. Dedup keys
   `(V, source, candidate)` triples so we don't re-try the same combo,
   but if N sources all serve V we'll build N piggybacks per UTXO.
   Revisit if this produces visible churn; "first-trusted-only" is a
   simple bound to add.
2. **Pre-publish piggyback (incentive cancellation).** Deferred. The
   design doc previously discussed cancelling an enqueued incentive when
   a trusted source appears before publication. This requires PutManager
   introspection that doesn't exist; tracked in `TODO.md` and not yet
   scoped.
3. **Collateral staking on verified piggybacks.** Deferred to a node-
   policy hook (TODO.md). Phase 3 ships piggyback without auto-staking;
   the broadcast piggyback racing against the original responder will
   typically lose if the original posted FOR collateral. Acceptable
   trade-off for the first implementation.
4. **Copy fidelity.** We copy the record bytes verbatim. What if the
   contract requires the record data to be *re-derived* (e.g. includes
   timestamps, block-specific identifiers)? Local verify catches this;
   we discard. Flag as contract-incompat if frequent.
5. **Claim-history pollution.** Piggyback blocks appear in claim history
   too. Do they skew gossip routing? Probably fine — they legitimately
   claim V and legitimately serve future V-requesters. Monitor.

---

## Implementation

- New file `src/node/strategies/PiggybackStrategy.ts`.
- Registered by `Scaffold` alongside `FetchNotifyStrategy`.
- Not in `src/core/` — runtime policy, not protocol primitive.
