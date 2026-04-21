# Piggyback — Design

> Status: design sketch, not yet implemented. Consumed by [fetch](fetch.md).
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

Piggyback fixes both. When the node sees a trusted block containing the
answer to V, it **builds its own claiming block** that references the
source, reproduces the record, and claims our pending incentive. No new
responder work, no duplicate payment, and Carol's old block stays
economically alive as a source.

---

## Core flow

Triggered whenever a block enters `Trusted` state and one of our active
fetch subscriptions might be served by it.

```
1. Scan block.claims. Does it claim an output whose verifier matches
   any of our active fetch subscriptions V?
       No  → not a source.
       Yes → we have a trusted response to V. Continue.

2. Does this block claim OUR incentive output for V?
       Yes → nothing to do; FetchNotifyStrategy already handles it.
       No  → piggyback candidate.

3. For each active fetch (contract V, recordKey K) whose incentive is
   unspent:
     a. Construct a piggyback block:
          anchor:     our canonical tip
          refs:       [source block]
          outputs:    [self-claimed RECORD at K copied from source]
          claims:     [our incentive output]
          collateral: none (yet)
     b. Run local verification against the piggyback.
          Accept  → surface as a FetchClaim to callbacks.
          Reject  → discard. Wait for a real responder.
     c. Publish the piggyback (best-effort race to claim our incentive
        before the original responder does).
     d. Optionally, stake FOR collateral on the piggyback. This is the
        same decision as "would we stake on anything we verified?" —
        governed by node policy, not fetch-local.
```

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
// New reactive strategy, sibling to FetchNotifyStrategy.
class PiggybackStrategy implements Strategy {
  constructor(
    private fetchManager: FetchManager,
    private trustGate: TrustGate,
    private blockBuilder: BlockCreationService,
    private executor: ExecutionService,   // for local verify
  ) {}

  evaluate(event: ReactiveEvent): Action[] { ... }
}
```

It emits `buildAndSubmit` actions (piggyback blocks) and `notifyFetch`
actions (surfacing pre-publish copies).

---

## Open questions

1. **Bounded piggyback attempts.** A popular verifier might have many
   trusted sources. Do we piggyback on the first trusted one we see, or
   keep updating when a better one arrives? Leaning: first-trusted to
   avoid churn; upgrade only if current source loses canonicality.
2. **Incentive cancellation timing.** Pre-publish piggyback cancels the
   enqueued incentive. If multiple fetches share the incentive (dedup)
   and one piggybacks while another is still waiting, who wins? Leaning:
   cancel the incentive only when *all* deduped subscribers have been
   served by piggyback; otherwise publish. Note that `publish: false`
   subscribers alone never force publication — an incentive with *only*
   `publish: false` subscribers stays local forever; adding a
   `publish: true` subscriber graduates the incentive to the network.
3. **Copy fidelity.** We copy the record bytes verbatim. What if the
   contract requires the record data to be *re-derived* (e.g. includes
   timestamps, block-specific identifiers)? Local verify catches this;
   we discard. Flag as contract-incompat if frequent.
4. **Claim-history pollution.** Piggyback blocks appear in claim history
   too. Do they skew gossip routing? Probably fine — they legitimately
   claim V and legitimately serve future V-requesters. Monitor.

---

## Implementation

- New file `src/node/strategies/PiggybackStrategy.ts`.
- Registered by `Scaffold` alongside `FetchNotifyStrategy`.
- Not in `src/core/` — runtime policy, not protocol primitive.
