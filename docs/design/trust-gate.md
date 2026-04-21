# Trust Gate — Design

> Status: design sketch, not yet implemented. Consumed by [fetch](fetch.md)
> and [piggyback](piggyback.md).

## Problem

A node receives many blocks through ingestion and gossip. Most are fine;
some are structurally malformed; some are computationally invalid. Before a
user-facing consumer (a fetch callback, a piggyback copy, our own
collateral posting) *acts* on a block, the node needs a cheap yes/no
answer to "do I believe this block is valid?"

Without this gate, an attacker can publish an uncollateralized invalid
block and get honest nodes to amplify it (piggyback it, surface it to
callers) before the sampling/deception layer catches on. The gate makes
that attack unprofitable by refusing to act on untrusted blocks.

Ingestion, storage, and gossip are **not** gated. We still receive and
relay the block — we just don't act on its contents.

---

## Definition

A block is **trusted** iff one of:

1. **Locally verified** — the node ran the response contract against the
   block and it accepted, within the node's verification budget.
2. **Canonically collateralized** — a canonical block carries FOR collateral
   targeting this block (per the collateral contract).

Otherwise the block is **untrusted**.

"Canonical" here means the block carrying the collateral is itself
canonical *and* trusted (recursive, but the recursion bottoms out on
signature contracts, which are cheap to verify locally).

---

## State model

Per-block trust state:

- `Untrusted` (initial) — ingested, not yet evaluated or not yet
  trust-worthy.
- `Verifying` — local verification in progress.
- `Trusted (verified)` — local verification accepted.
- `Trusted (collateralized)` — canonical FOR collateral present on the
  block. Evaluated on-demand against the current canonicality state.
- `Rejected` — local verification explicitly rejected. Permanent for this
  block's bytes. (The block stays in the store — we might still need it
  for referencing, proofs, etc. — but it is never re-entered for trust
  evaluation.)

Transitions:

- `Untrusted → Verifying → Trusted(verified) | Rejected` — driven by the
  node's verification queue.
- `Untrusted → Trusted(collateralized)` — triggered when a canonical
  collateral-posting block is ingested and its target matches.
- `Trusted(collateralized) → Untrusted` — if the collateral block loses
  canonicality. (Local verify can still promote it back to
  `Trusted(verified)`.)

`Trusted(verified)` is sticky — local verification is deterministic, so
once we accept, we don't re-evaluate. A later `Rejected` verdict on the
same bytes is impossible by construction.

---

## Verification scheduling

Local verification is not free; we can't verify every ingested block.
Scheduling is **lazy and on-demand**:

- When any consumer asks for a trust decision on a block, and the state is
  `Untrusted`, kick off verification (if not already queued).
- Prioritize verification in order of downstream demand: blocks that are
  actively blocking a fetch or a piggyback attempt come first.
- Cheap-contract blocks (signature, timelock) verify in the current thread.
- Hard-contract blocks verify in a worker with a per-contract budget.

Consequence: a block may sit as `Untrusted` indefinitely if no consumer
cares about it. That's fine — trust is computed only when it matters.

---

## Consumers

| Consumer | Consults Trust Gate? |
|---|---|
| Block ingestion | **No** — we accept all well-formed blocks. |
| Gossip | **No** — we relay regardless. |
| Sampling (existing) | Independent — runs its own verification cycle. |
| Consensus / weight | **No** — canonicality computation doesn't change. |
| Fetch callbacks | **Yes** — only fires for trusted blocks. |
| Piggyback copy | **Yes** — only piggybacks from trusted sources. |
| Posting our own collateral | **Stricter** — only ever on blocks we verified locally. We do *not* stake based on someone else's collateral signal, because the deception layer makes it profitable for others to lie to us about trust. |

The stricter rule for collateral-posting means: "trust" has two tiers in
practice. Surfacing / piggybacking is fine with collateral-backed trust;
staking is not.

---

## Interface sketch

```ts
class TrustGate {
  // Non-blocking. If untrusted and verification budget is available,
  // schedules verification.
  status(hash: Hash): TrustStatus;

  // Blocking. Resolves once the block is Trusted or Rejected.
  // Rejects with VerificationRejected / Timeout / etc.
  awaitTrusted(hash: Hash, opts?: { timeoutMs?: number }): Promise<void>;

  // Returns the list of hashes that just moved to Trusted (so strategies
  // can re-run their logic on newly-trusted blocks).
  onTrustChanged(cb: (hash: Hash) => void): () => void;
}

type TrustStatus =
  | { kind: 'untrusted' }
  | { kind: 'verifying' }
  | { kind: 'trusted', basis: 'verified' | 'collateralized' }
  | { kind: 'rejected', reason: string };
```

---

## Open questions

1. **Verification budget.** We need a policy: max concurrent verifications,
   per-contract timeouts, priority queue rules. Initial approach: single
   worker, FIFO prioritized by "is this blocking a live fetch?", hard
   timeout per contract. Iterate on measurement.
2. **Collateralized-trust decay.** A collateral-backed trust is only as
   good as the collateral still being canonical. How aggressively do we
   re-check? Probably: subscribe to canonicality changes on the
   collateral block, flip trust state on change.
3. **Minimum collateral threshold.** Should `Trusted(collateralized)`
   require a minimum FOR amount, or is any collateral sufficient? Any
   non-zero amount seems fine — the attacker is paying real value if
   wrong.
4. **Cache persistence.** On node restart, do we persist verification
   verdicts? Good for restart speed; complicates the bookkeeping. Defer.
5. **Interaction with sampling.** The existing sampling module already
   runs verification for weight-derivation purposes. Can/should the trust
   gate reuse those results to avoid double-verification? Likely yes,
   but the integration is non-trivial — leave a `TODO` and run a
   standalone pass for v1.

---

## Implementation

- New file `src/node/TrustGate.ts` (module + service seam TBD).
- Consumed by `FetchNotifyStrategy`, the piggyback strategy (new), and
  whatever does collateral-posting.
- Not in `src/core/` — this is runtime policy, not protocol primitive.
