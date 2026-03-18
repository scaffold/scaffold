# Block Drafts

A **block draft** is a local-only representation of a block that is being constructed but has not yet been published. Drafts participate in the local node's consensus and conflict views — contributing weight and pre-claiming outputs — but are invisible to peers and cannot be built upon, aggregated, or claimed.

Drafts exist because block construction is not instantaneous. Generating a computation result, aggregating heavy subtrees, or waiting for economic inputs all take time. During that time, the canonical view evolves: new blocks arrive, conflicts resolve, outputs get claimed. Without drafts, the node operates blind during construction — it doesn't know whether the block it's building will be canonical when published, it might duplicate work another peer is already doing, and it can't influence its own canonicality decisions with knowledge of its in-progress work.

---

## Data Model

### ResolvedClaim

A claim expressed as a direct reference to a specific output on a specific block, rather than an index into an extended output vector:

```
ResolvedClaim {
    block:       Hash     // the block that produced the output
    outputIndex: number   // which output on that block
    value:       number   // economic value of the claimed output
}
```

This is the **semantic** representation of a claim. The wire format (`claims: Index[]`) is an encoding of resolved claims relative to a specific anchor — it is computed at composition time when the anchor is resolved. `ResolvedClaim` is anchor-independent: it means the same thing regardless of where the block ends up in the graph.

`ResolvedClaim` should also appear on the `Block` interface as a `resolvedClaims` field alongside the existing `claims: number[]` field. Using the same field name on both `Block` and `BlockDraft` allows consumers to work with claims uniformly without knowing which type they're dealing with, and without needing to reverse-engineer the extended vector mapping. The index-based `claims` field becomes a wire-format concern computed at composition time by the [anchoring module](anchoring.md).

### BlockDraft

```
BlockDraft {
    draftId:        DraftID          // local-only identity (random hash or UUID)
    resolvedClaims: ResolvedClaim[]  // outputs being claimed (semantic form)
    outputs:        Output[]         // new outputs this block will produce
    declaredWeight: number           // work this block contributes
    refs:           Hash[]           // read-only cross-block references
    aggregates:     Hash[]           // blocks this draft aggregates
    anchor:         Hash             // phantom anchor (derived, updated on recreate)
    status:         DraftStatus      // pending | generating | ready | cancelled
}
```

A draft has **no hash** (it hasn't been serialized) and **no signature**. The `anchor` field is a **phantom anchor** — a best-guess placement that allows the draft to participate in consensus, but which may change before publication. The `aggregates` field is explicit because aggregation interacts with anchor selection -- which blocks are aggregated determines which claims are reachable via subtrees vs. via the anchor chain. See [Anchoring](anchoring.md).

The construction pipeline becomes:

1. Create a `BlockDraft` with `resolvedClaims`, `outputs`, `aggregates`, etc.
2. The anchoring module computes the anchor and maps `resolvedClaims` to indices.
3. `BlockCreationModule.buildBlock()` takes the computed spec and produces a `BlockBlueprint`.
4. Sign and publish.

### Replacing BlockSpec

`BlockDraft` replaces `BlockSpec` as the primary input for block construction. `BlockSpec` was a one-shot construction input with index-based claims and a fixed anchor — these are now derived properties computed by the [anchoring module](anchoring.md) at composition time.

`BlockSpec` may survive as an internal intermediate representation within the anchoring module, but it is no longer a user-facing type.

### What a Draft Is Not

- Not a `Block`. It cannot be stored in `BlockStore`, referenced by hash, or sent to peers.
- Not persistent across restarts. Drafts are ephemeral local state. If the node restarts, in-progress work is lost (the generation must restart).

---

## Immutability and Recreation

Drafts are **immutable**. When a draft's state changes — its anchor shifts, it acquires a new claim, a ref is added, or it's promoted to a real block — the old draft is deleted from the graph and a new one is created with the updated state. This is the same pattern as blocks themselves: identity is tied to content.

Recreation triggers include:

- **Anchor change**: the phantom anchor is no longer optimal (e.g., a new canonical tip appeared that is a better common ancestor of the claims).
- **Claim change**: the generation process determines it needs an additional input, or an existing claim becomes unavailable.
- **Ref change**: the computation needs to reference a block that wasn't known when the draft was created. This changes the draft's content but does not affect the phantom anchor (refs are free-floating).
- **Publication**: the draft is finalized into a real block. The draft is deleted; the block takes its place in the graph, inheriting its weight and conflict contributions.
- **Cancellation**: the draft is no longer viable (the claim became unrecoverably non-canonical, or a peer published a competing block that won).

The delete-and-recreate pattern ensures that consensus and conflict modules never need to handle in-place mutations — they process additions and removals, which they already support.

---

## Phantom Anchor

A draft must have an anchor to participate in consensus (weight needs a chain to attribute to) and conflict detection (claims need an output space to compare against). But the final anchor isn't known until publication. The **phantom anchor** bridges this gap.

### Derivation

The phantom anchor is chosen as the **shallowest canonical block that is a descendant of all required ancestors** (claimed blocks, subtree anchors, include constraints). Formally:

```
phantom_anchor = shallowest block A such that:
    for every Category C claim: claim.block is an ancestor of A (or A itself)
    for every subtree S: S.anchor is an ancestor of A (or A itself)
    AND A is canonical
```

This places the anchor as close to genesis as possible while still being able to express all claims as indices into A's extended output vector. Shallower blocks have more descendant weight and are more stable — their canonicality is less likely to change, minimizing phantom anchor churn.

### Additional Constraints

At publication time, the anchor may have additional constraints beyond covering the claims:

- **Negative constraints**: for collateral blocks, the anchor must NOT be a descendant of the target block. This ensures the collateral remains valid even if the target is removed from the canonical view.
- **UTXO availability**: economic inputs (balance outputs for throughput balancing) must exist in the anchor's UTXO set.

Refs are **not** an anchor constraint. Referenced blocks do not need to appear in the anchor chain or be ancestors of the block. Refs are free-floating pointers — the protocol only requires that the referenced block exists and is available for read access during execution and verification. The anchor chain is determined solely by claims and aggregation.

The phantom anchor need not satisfy all publication-time constraints — it is a best-effort placement for speculative consensus participation. At publication time, the real anchor is computed with full constraints, and may differ.

### Re-derivation

When the canonical view changes (new blocks, conflict resolutions), the phantom anchor may become suboptimal:

- A deeper block now covers all claims (anchor should move forward).
- The current anchor became non-canonical (anchor must retreat).
- A new claim was added that isn't covered by the current anchor (anchor must retreat).

Any change to the phantom anchor triggers a draft recreation (delete old, create new with updated anchor).

---

## Consensus Integration

### Speculative Weight

A draft contributes its `declaredWeight` to the canonical view through its phantom anchor, exactly as a real block would. The consensus module sees the draft as a block with weight attributed to its anchor chain.

This has concrete effects:

- **Ancestors become heavier**. If a draft with weight 10 builds on chain C, the effective weight of C increases by 10. If C was losing a conflict by 7, the draft tips it to winning by 3.
- **Conflict resolution shifts**. The draft's weight can flip which branch wins a conflict, even before the draft is published. The node's local canonical view reflects the work it is about to contribute.

### Generation Cancellation

The draft's own canonicality is continuously monitored. If the draft becomes non-canonical — meaning even with its own weight contribution, its branch loses — then the generation should be cancelled. The block, once published, would be non-canonical immediately, so the work is wasted.

More precisely: the draft should be cancelled when its **canonicality margin** (the weight difference between its branch and the strongest competing branch) goes negative by more than the draft's own declared weight. At that point, even publishing the draft wouldn't rescue the branch.

### Weight Transition

When a draft is published (converted to a real block), the weight transition must avoid double-counting:

1. Remove the draft from consensus (delete its phantom weight contribution).
2. Add the real block to consensus (with its actual anchor and hash).
3. The net weight change should be zero if the anchor didn't change, or a small adjustment if it did.

The delete-and-recreate pattern handles this naturally — publication is just another recreation where the new entity is a `Block` instead of a `BlockDraft`.

---

## Conflict Integration

### Pre-claiming

A draft's `ResolvedClaim` entries are registered in the conflict module. For each claim `{ block: X, outputIndex: i }`, the output is marked as claimed by the draft. This has two effects:

1. **Prevents double-generation**. If two strategies both want to generate a response to the same output, the second one sees the output is already pre-claimed and does not start.
2. **Detects external conflicts**. If a peer publishes a block that claims the same output, a conflict is detected between the peer's block and the draft. The node can then decide whether to continue generating (if it expects to win the conflict) or cancel.

### Scatter-to-Source

Pre-claiming uses the scatter-to-source pattern: claims are stored on the **producing block** at the output index, not on the claiming block. This mirrors the legacy `propagateClaims` approach:

For a resolved claim `{ block: X, outputIndex: 3 }`, the claim is recorded on block X's output 3 as "claimed by draft D". Conflict detection becomes a lookup: if output 3 of block X has multiple claimants, those claimants conflict.

This is simpler than BitVector intersection for drafts because:
- No anchor is needed to compute the claim's position.
- Conflict detection is O(1) per output (check the claimant list).
- The same data structure works for both drafts and published blocks.

Published blocks can also populate this structure (by scattering their index-based claims through the anchor chain to the source outputs), providing a **unified conflict view** across drafts and real blocks.

### Aggregator-Aggregated Conflict

An aggregation block and the blocks it aggregates have overlapping claim masks — the aggregator carries the union of its subtrees' claims. This means they conflict by the standard definition (overlapping claims on the same ancestor outputs).

This is correct and intentional:

1. **Prevents re-aggregation**. A block that has been aggregated cannot be aggregated again by a different aggregator, because the two aggregators would conflict (both include the same leaf's claims).
2. **Practical anchor selection**. When selecting an anchor, prefer the aggregator over its leaves. The aggregator's output vector already accounts for the leaves' claims, giving a cleaner starting point with fewer historical claims to navigate.

### Open Question: Aggregator vs. Aggregated Weight

The aggregator does **not** automatically have more descendant weight than its leaves. In fact, it has **less**: the aggregator is a descendant of the aggregated blocks (in the DAG's aggregation sense), so blocks built on top of the leaves contribute to the leaves' effective weight but not to the aggregator's. A leaf with substantial descendant weight can beat its own aggregator in a conflict.

The aggregator is, however, **strictly more informative** — its output vector reflects a more resolved state (more claims applied, more outputs consolidated). This "informativeness" or "resolution depth" is a useful property for anchor selection and graph navigation, but it is not captured by the current weight-based conflict resolution.

How to formalize this preference — whether through a separate metric, through incentive design (encouraging blocks to anchor to aggregators rather than leaves), or through some other mechanism — remains an open question. For now, conflict resolution uses effective weight only, and anchor selection uses an independent heuristic that prefers more-resolved blocks. See [Anchoring](anchoring.md) for the anchor selection algorithm.

---

## Anchor Derivation at Publication

When a draft is finalized into a real block, the anchor is computed — not chosen in advance. The same algorithm computes both phantom anchors (for drafts) and real anchors (for publication), with different options controlling the preference heuristic.

The full anchor derivation algorithm — including how aggregation, include/exclude constraints, and UTXO availability interact — is specified in the [Anchoring Module](anchoring.md). The key property: claim indices exist only at the wire-format boundary. They are computed from `resolvedClaims` and the chosen anchor as the final step before building the block. The rest of the system works with `ResolvedClaim`.

---

## Lifecycle

```
    pending ──→ generating ──→ ready ──→ published
       │            │            │
       └──→ cancelled ←──────────┘
```

### Pending

The draft has been created with its claims and outputs, but generation has not started. It participates in consensus (phantom weight) and conflict (pre-claiming). This state is useful for drafts that are waiting for a precondition — e.g., an output to become canonical before starting generation.

### Generating

Active computation is in progress. The contract may be actively executing, or it may be **blocked** waiting for additional inputs via `requireInput()`. A blocked generator is suspended (no CPU) until the system provides a new input matching its verifier. See [aggregation: blocking requireInput](aggregation.md#blocking-requireinput) for details.

The draft may be recreated during this phase as claims, refs, or the anchor change. Each recreation preserves the generation state (the computation continues; only the draft's graph participation is updated).

### Ready

Generation is complete. The draft has all the data needed to build a real block. It awaits a final anchor derivation and publication.

### Published

The draft has been converted to a real block. The draft is deleted from the local draft store; the block exists in `BlockStore` with a real hash. The weight and conflict contributions transition seamlessly (delete draft, add block).

### Cancelled

The draft is no longer viable. Reasons include:
- The claimed output became non-canonical and unrecoverable.
- A competing block claimed the same output and won the conflict.
- The canonicality margin went negative beyond the draft's weight.
- The user or strategy explicitly cancelled the generation.

The draft is removed from consensus and conflict. Any in-progress computation is aborted.

---

## Interaction with Other Modules

### Block Creation Module

The block creation module gains a new entry point: `publishDraft(draft) -> Block`. This performs anchor derivation, claim index computation, throughput balancing, and block construction in one step. The existing `buildBlock(spec)` continues to work for non-draft block creation.

The `autoBalance` function simplifies significantly: instead of computing UTXO indices relative to a pre-chosen anchor, it works with `ResolvedClaim` objects and only maps to indices after the anchor is derived.

### Reactive Layer / Strategies

Strategies that create blocks (generation, aggregation) should create drafts instead of emitting `createBlock` actions directly. The reactive layer manages the draft lifecycle:

- On canonicality change: re-evaluate drafts, recreate if anchor changed, cancel if unviable.
- On conflict: check if any draft is now in conflict, decide whether to continue or cancel.
- On generation complete: transition draft to `ready`, then publish.

### UTXO Index

The UTXO index should account for draft pre-claims. An output claimed by a draft is not available for other drafts or for `autoBalance` to select as an economic input. When a draft is cancelled, its pre-claims are released.

---

## Implementation Considerations

### Identity

Drafts need a stable local ID that survives recreation. Two options:

1. **Random hash**: `DraftID = Hash.random()`. Simple, unique, but unrelated to content.
2. **Semantic ID**: derived from the draft's purpose (e.g., hash of the verifier being satisfied). This naturally deduplicates — two strategies targeting the same output produce the same draft ID.

Option 2 is preferred for deduplication, with a random tiebreaker for drafts with identical purposes.

### Storage

Drafts live in a `DraftStore` separate from `BlockStore`. The draft store is local-only, not persisted, and not gossiped. It provides:

- `add(draft)` / `remove(draftId)` — triggers consensus/conflict updates.
- `getByClaimedOutput(block, outputIndex)` — for checking pre-claims.
- `getAll()` — for reactive re-evaluation on canonical changes.

### Consensus Module Changes

The consensus module needs to handle draft weight. Two approaches:

1. **Phantom block**: register the draft as a block in the consensus module using its `draftId` as the hash. The module doesn't know or care that it's a draft — it just sees a block with a weight vector and an anchor. On recreation, remove the old phantom and add the new one.
2. **Side-channel weight**: maintain a separate weight contribution map for drafts, merged into canonicality computation. Keeps the consensus module pure but duplicates weight logic.

Approach 1 (phantom block) is simpler and reuses existing machinery. The consensus module already handles block additions and removals.

### Conflict Module Changes

The conflict module can support resolved claims alongside index-based claims:

1. Maintain a per-output claimant index: `Map<(Hash, number), Set<Hash | DraftID>>`.
2. When a block is added, scatter its index-based claims to populate this index.
3. When a draft is added, directly insert its resolved claims.
4. Conflict exists when any output has multiple claimants.

This unifies conflict detection for drafts and blocks without requiring drafts to produce BitVector masks.

---

## Module Boundary

### This Module Receives

| Input | Source | Description |
|-------|--------|-------------|
| Generation requests | Strategies / reactive layer | Intent to create a block satisfying some output |
| Canonical view updates | Consensus module | For phantom anchor re-derivation and cancellation checks |
| Conflict notifications | Conflict module | When a draft's pre-claimed output is also claimed by another block |
| Generation results | Execution engine | Completed computation output for a generating draft |

### This Module Provides

| Output | Consumer | Description |
|--------|----------|-------------|
| Phantom weight contributions | Consensus module | Draft weight attributed to the phantom anchor chain |
| Pre-claim registrations | Conflict module | Outputs claimed by in-progress drafts |
| Published blocks | Block creation module | Finalized blocks ready for signing and distribution |
| Cancellation signals | Execution engine | Stop in-progress generation when a draft becomes unviable |

---

## Relation to Existing Docs

- [Block Creation](block-creation.md): the existing Draft System section describes drafts as generator functions. This document formalizes that concept with a concrete data model and lifecycle. The `BlockDraft` type replaces the informal `DraftGenerator` concept.
- [Conflict](conflict.md): the scatter-to-source claim tracking and per-output conflict detection extend the existing BitVector-based approach. Both mechanisms coexist.
- [Consensus](consensus.md): phantom weight is a local-only extension. The canonical view exposed to peers does not include draft weight — it is a speculative local adjustment.
- [DAG](dag.md): drafts are not part of the DAG. They influence the local node's conflict view but are invisible to the network.
