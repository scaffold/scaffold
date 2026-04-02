# Output Claims Module

The output claims module tracks which blocks claim each output in the block graph. It provides the reverse mapping from outputs to their claimants, complementing the forward mapping (block -> claim indices) stored in the block itself.

This module is responsible for:
- Tracking per-output claimant lists on every block
- Migrating claim entries toward the actual producing block as the DAG loads
- Populating `resolvedClaims` when a claim reaches its producing block
- Detecting double-spend conflicts: when migration places a second claimant on the same output, the module detects a double-spend conflict and reports it to the consensus module

This module is **not** responsible for:
- Deciding which claimant wins (that's the [consensus module](consensus.md))
- Constructing blocks or computing claim masks (that's [block creation](block-creation.md))

---

## Prerequisite: Extended Vector and Claim Resolution

A block's **output space** is its final, post-claim set of surviving outputs -- the clean set that descendants inherit. During construction, claim indices are resolved against the **extended vector**: the block's own outputs prepended to the inherited outputs, before claims are applied. **Outputs are added before claims are applied.** This ordering is what enables self-claiming: a block can produce an output at index 0 and claim index 0 in the same block.

A claim at index I in `block.claims` refers to index I in the block's extended vector, not in its final output space or the anchor's output space.

A block C's extended vector (used for claim resolution):

```
[0 .. C.outputs.length-1]                              -> C's own outputs
[C.outputs.length .. +agg[-1].newOutputCount-1]         -> last aggregate's new outputs
[... +agg[-2].newOutputCount-1]                         -> second-to-last aggregate
...
[C.outputs.length + SUM(agg[*].newOutputCount) ..]      -> C's anchor's surviving outputs
```

---

## Output Claim Entries

Each entry in the output claims map records a claimant and which of its claims produced the entry:

```
OutputClaimEntry {
    claimant:    Hash     // block hash or draft ID of the claiming block
    claimIndex:  Number   // index into the claimant's claims[] array
}
```

The `claimIndex` is needed so that when migration completes, we can populate the correct slot in the claimant's `resolvedClaims`.

---

## Claim Registration

When block C is loaded with claims, each claim is registered on C itself:

1. For each `C.claims[claimIndex]` with value I:
   - Place `{claimant: C.hash, claimIndex}` on **C's own** outputClaims at index I
   - Immediately attempt migration from C

Self-claims (I < C.outputs.length) resolve immediately during migration -- the producing block is C itself.

---

## Migration

Migration moves claim entries from their starting block toward the block that actually produced the claimed output. An entry migrates one hop at a time through the aggregation hierarchy.

Given an entry at index I on block B:

1. **Resolved**: If I < B.outputs.length, the claim targets B's own output at index I. The entry is resolved -- populate the claimant's `resolvedClaims` with `{block: B.hash, outputIndex: I}`.

2. **Descend through aggregates**: If I >= B.outputs.length:
   - Compute R = I - B.outputs.length
   - Walk B's aggregates in reverse order. For each aggregate:
     - If R < aggregate's `newOutputCount` (from `aggregateOutputCounts`): the entry belongs to this aggregate's output space at index R. Move it there and recurse (using `resolveOutputSpaceIndex` to map through the aggregate's claims).
     - Else: R -= aggregate's `newOutputCount`. Continue to next aggregate.
   - If R survives all aggregates: R indexes into the **surviving** anchor outputs (post-subtree-claims). Map through the aggregate subtree claim mask to get the original anchor output space index, then move the entry to the anchor at that index. Recurse.

   This is the same algorithm as `resolveClaimIndex` / `resolveOutputSpaceIndex` in the [output space module](output-space.md#claim-index-resolution), applied one hop at a time.

3. **Stuck**: If the target block (aggregate or anchor) is not loaded, the entry stays on B. It will migrate when the target block loads.

### Triggered Migration

When a new block X is loaded, check if any existing block has stuck entries that map to X. Specifically, look for blocks that reference X as an aggregate or anchor and have outputClaims entries with indices in X's range. Migrate those entries onto X and recurse.

To make this efficient, the module maintains a reverse index: for each unloaded hash, which blocks have entries waiting for it.

---

## Module Boundary

### This Module Receives

| Input | Source | Description |
|-------|--------|-------------|
| Block claims | Block creation / wire format | `claims[]` array on each block |
| Block structure | Provider interface | Outputs, aggregates, anchor for index arithmetic |
| Block load events | Coordinator | Notification when a new block enters the store |

### This Module Provides

| Output | Consumer | Description |
|--------|----------|-------------|
| Per-output claimant lists | Application layer | Who claims each output on a given block |
| Resolved claims | Block drafts / application | Concrete `{block, outputIndex}` for completed migrations |
| Conflict declarations | Consensus module | Two blocks both claiming the same producing output |

### Invariants

1. **Claim conservation**: Every claim in a block's `claims[]` array has exactly one corresponding entry somewhere in the outputClaims system -- either on this block, on an aggregate or anchor block further down the hierarchy, or resolved.
2. **Monotonic migration**: Entries only move toward the producing block, never away from it.
3. **Resolution correctness**: A resolved claim at `{block: B, outputIndex: I}` means `I < B.outputs.length` -- it refers to an actual local output.

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/OutputClaimModule.ts`](../../src/core/OutputClaimModule.ts) | Core algorithm: claim registration, migration, resolution |
| [`src/core/OutputClaimService.ts`](../../src/core/OutputClaimService.ts) | Wired adapter using concrete `Block` type |
