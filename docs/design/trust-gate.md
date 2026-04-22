# Trust Gate — Design

> Status: implemented (standalone). Not yet wired into [fetch](fetch.md) or
> the piggyback strategy ([piggyback.md](piggyback.md)) — that comes in
> later phases. See `src/node/TrustGate.ts`, `src/node/TrustGateService.ts`,
> `src/node/CollateralResolutionIndex.ts`.

## Problem

A node receives many blocks through ingestion and gossip. Most are fine;
some are structurally malformed; some are computationally invalid. Before
a user-facing consumer (a fetch callback, a piggyback copy, our own
collateral posting) *acts* on a block, the node needs a cheap yes/no
answer to "do I believe this block is valid?"

Without this gate, an attacker can publish an uncollateralized invalid
block and get honest nodes to amplify it (piggyback it, surface it to
callers) before the sampling/deception layer catches on. The gate makes
that attack unprofitable by refusing to act on untrusted blocks.

Ingestion, storage, and gossip are **not** gated. We still receive and
relay blocks — we just don't act on their contents.

---

## Definition

A block is **trusted** iff one of:

1. **Locally verified** — the node ran the response contract against the
   block and it accepted, within the node's verification budget.
2. **Collateral-backed** — a canonical resolution source has emitted a
   `valid` verdict output targeting this block (see below).

A block is **rejected** iff one of:

- Local verification **failed** (deterministic and final for these bytes).
- A canonical resolution source emitted an `invalid` verdict and no local
  verification overrides it.

Otherwise the block is **untrusted**.

### Local verification always wins

When we have locally verified a block, that result overrides any
resolution verdict — block or draft, `valid` or `invalid`. Our own
deterministic computation is the strongest signal available.

**Why this matters (under-funded FOR example):** suppose a target block
H has 1 coin FOR and 10 coins AGAINST. We verify H ourselves and it
passes. Our local generator's legislation logic posts, say, 5 coins
FOR (the most we own). Totals become 6 FOR vs 10 AGAINST; the
resolution generator produces a draft in Mode 3 (unresolved challenge,
AGAINST wins) whose verdict output says `invalid`. The network agrees
— H will be collaterally marked invalid — but *we verified it
ourselves*, so we still treat H as trusted. The resolution verdict is
a useful economic signal about what the network concluded, but it is
never authoritative over a local yes/no we computed ourselves.

---

## Trust state

```ts
type TrustStatus =
  | { kind: 'untrusted' }
  | { kind: 'trusted'; basis: 'verified' | 'collateralized' }
  | { kind: 'rejected'; reason: 'local verification' | 'collateral resolution' };
```

Precedence (evaluated in order):

1. `getVerificationStatus(h) === 'passed'` → `trusted(verified)`. **Final.**
2. `getVerificationStatus(h) === 'failed'` → `rejected(local verification)`. **Final.**
3. `index.verdict(h) === 'invalid'` → `rejected(collateral resolution)`. Revocable.
4. `index.verdict(h) === 'valid'` → `trusted(collateralized)`. Revocable.
5. Otherwise → `untrusted`.

`rejected(local verification)` and `trusted(verified)` are deterministic
for the block's bytes and therefore final for those bytes. Collateral-
derived states can flip when a source's canonicality flips or when a
newly-arriving verdict source changes the winner.

---

## Verification scheduling

Local verification is not free. Scheduling is **lazy and on-demand**:

- `TrustGate.status(h)` is a pure read — it never triggers verification.
- `TrustGate.awaitTrusted(h, opts?)` is active: if currently `untrusted`,
  it calls `requestVerification(h)` on the underlying
  `BlockVerificationService`, which is dedup-aware (in-flight verify
  promises are shared; cached results are returned immediately).
- Resolves on the first `trusted` transition (returning the
  `TrustStatus`); rejects on the first `rejected` transition or on
  optional timeout.

Cheap-contract blocks (signature, record) verify in the current thread.
Hard-contract blocks verify via the execution queue.

---

## Resolution verdict interface

Trust signals from the network come via **verdict record outputs** on
collateral-resolution blocks, not via raw FOR / AGAINST postings.

The `COLLATERAL_CONTRACT` emits a `RECORD_CONTRACT` output with key
`"verdict"` and payload `{ target, verdict: 'valid' | 'invalid' }` in
each resolution mode (1/2/3). Mode 4 (non-canonical reclaim) emits no
verdict — it carries no trust signal. The contract guarantees the
verdict matches the mode, so the index doesn't need to re-derive
resolution logic; it just reads the output.

See [`docs/protocol/collateral-resolution.md`](../protocol/collateral-resolution.md#verdict-record-output)
for the on-wire encoding.

### Sources that contribute verdicts

A resolution source contributes a verdict iff:

- it is **canonical**, AND
- for **blocks**: `BlockVerificationService.getStatus === 'passed'`, OR
- for **drafts**: status is `'ready'`.

Drafts are included because anchor-chain Rule 1/2 makes a canonical
draft a strong proxy for a block we'll solidify — but drafts are *not*
treated as automatically correct. The verdict a draft emits can still
be wrong (under-funded FOR placement as above); the index just
surfaces what the contract said, and the precedence rules above
handle disagreement with our own local verification.

Non-canonical sources (block or draft) do not contribute. When a
source loses canonicality, its verdict is withheld from queries and
dependents re-evaluate.

Verdicts compose with `invalid > valid > none` — one canonical-verified
Mode 3 invalidates a target even if twenty Mode 1 resolutions say
`valid`.

---

## Interface

```ts
class TrustGate {
  /** Pure read. Never triggers verification. */
  status(hash: Hash): TrustStatus;

  /**
   * Wait until the block is trusted or rejected. If currently untrusted,
   * kicks off `requestVerification(hash)` (dedup-aware). Resolves with
   * the trusted TrustStatus (so callers know verified vs collateralized);
   * rejects with VerificationRejectedError / CollateralRejectedError /
   * TrustTimeoutError.
   */
  awaitTrusted(
    hash: Hash,
    opts?: { timeoutMs?: number },
  ): Promise<TrustStatus & { kind: 'trusted' }>;

  /** Fires once per real transition for a given hash. */
  onTrustChanged(cb: (hash: Hash, status: TrustStatus) => void): () => void;
}
```

Consumers should prefer `status()` for pure queries and `awaitTrusted()`
when they need a decision and are willing to drive verification.

---

## Consumers

| Consumer | Consults Trust Gate? |
|---|---|
| Block ingestion | **No** — we accept all well-formed blocks. |
| Gossip | **No** — we relay regardless. |
| Sampling | Independent — runs its own verification cycle. |
| Consensus / weight | **No** — canonicality computation doesn't change. |
| Fetch callbacks | **Yes** — only fires for trusted blocks. (Phase 4) |
| Piggyback copy | **Yes** — only piggybacks from trusted sources. (Phase 3) |
| Posting our own collateral | **Stricter** — only on blocks we verified locally. We do *not* stake based on someone else's collateral signal; a naive "trusted(collateralized)" trust is acceptable for surfacing but never for staking. |

The stricter rule for collateral-posting means trust has two tiers: the
`trusted` state is fine for surfacing / piggybacking, but staking policy
requires `basis === 'verified'` specifically.

---

## Architecture

Three cooperating pieces:

```
                  ┌──────────────────────────────┐
                  │   BlockVerificationService   │
                  │ (src/core; queue-dispatched) │
                  └──────────────┬───────────────┘
                                 │ getStatus / onStatusChanged / verify
                                 ▼
┌──────────────────────────┐   ┌─────────────────────────────────────┐
│ CollateralResolutionIndex│   │              TrustGate              │
│    (src/node; reads      │──▶│    (src/node; composes the two)     │
│     verdict record       │   │                                     │
│     outputs)             │   │   status / awaitTrusted /           │
│                          │   │   onTrustChanged                    │
└──────────────────────────┘   └─────────────────────────────────────┘
        ▲             ▲
  BlockStore.onAdded  │
  DraftStore.onTransition
  consensus.onCanonicalityChange
  blockVerification.onStatusChanged
```

- **`BlockVerificationService`** (Phase 1): owns the authoritative map
  of verification results, dedups concurrent verifies, exposes
  `getStatus` / `verify` / `onStatusChanged`.
- **`CollateralResolutionIndex`**: scans resolution blocks and ready
  drafts for verdict record outputs, gates entries on
  verification/canonicality/readiness, answers `verdict(target)`.
- **`TrustGate`**: the user-facing module. Composes verification status
  and resolution verdict into a single `TrustStatus`, with local verify
  overriding everything.

Services (`*Service.ts`) are thin DI adapters around the DI-agnostic
modules; the modules are tested in isolation with mock providers.

---

## Open questions

1. **Verification budget.** Policy for max concurrent verifications and
   per-contract timeouts. Currently inherits whatever the execution
   queue decides; tune later.
2. **Collateral-posting policy.** Should be stricter than general trust
   (local verify only). Node policy, separate concern — not implemented
   yet.
3. **Cache persistence.** On restart, do we persist verification
   verdicts? Deferred.

---

## Implementation

| Doc section | File |
|---|---|
| Module | [`src/node/TrustGate.ts`](../../src/node/TrustGate.ts) |
| Service | [`src/node/TrustGateService.ts`](../../src/node/TrustGateService.ts) |
| Error types | [`src/node/TrustErrors.ts`](../../src/node/TrustErrors.ts) |
| Verdict index | [`src/node/CollateralResolutionIndex.ts`](../../src/node/CollateralResolutionIndex.ts) |
| Verdict index service | [`src/node/CollateralResolutionIndexService.ts`](../../src/node/CollateralResolutionIndexService.ts) |
| Verdict encoding | [`src/contracts/CollateralContract.ts`](../../src/contracts/CollateralContract.ts) (`encodeVerdict`, `VERDICT_RECORD_KEY`, `readVerdictFromBlock`) |
| Tests | [`tests/TrustGate.test.ts`](../../tests/TrustGate.test.ts), [`tests/CollateralResolutionIndex.test.ts`](../../tests/CollateralResolutionIndex.test.ts), [`tests/CollateralContract.test.ts`](../../tests/CollateralContract.test.ts) (verdict-mode assertions) |
