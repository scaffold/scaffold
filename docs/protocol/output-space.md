# Output Space

The **output space** of a block is its final, post-claim set of surviving outputs -- the clean set that descendants inherit. This document defines the output space, the extended vector used for claim resolution, and the operations that modules perform against them.

For how aggregation composes output spaces, see [aggregation.md](aggregation.md). For conflict detection via claim masks, see [conflict.md](conflict.md). For claim migration through the hierarchy, see [output-claims.md](output-claims.md).

---

## Definition

A block's output space is the set of outputs visible to any block that anchors to it. It is the result of applying all the block's transformations -- subtree effects, own outputs, and own claims -- to the anchor's output space.

The output space is ordered. Outputs are indexed from 0. The ordering is newest-first: the block's own surviving outputs appear first, followed by aggregate-contributed outputs, followed by the anchor's surviving outputs.

```
Block B's output space:
    [B's surviving outputs (own outputs minus self-claims),
     aggregate[-1]'s new outputs,
     aggregate[-2]'s new outputs,
     ...,
     aggregate[0]'s new outputs,
     anchor's surviving outputs (after B's and subtrees' claims)]
```

Genesis has no anchor. Its output space is simply its own outputs.

---

## Extended Vector

The **extended vector** is a transient construction used during claim resolution. It is the block's own outputs prepended to the inherited outputs, **before** claims are applied:

```
Block B's extended vector:
    [B's own outputs (all, including those about to be self-claimed),
     post-subtree inherited outputs]
```

Where "post-subtree inherited outputs" is the state of the UTXO space after all aggregate subtrees have applied their transformations to the anchor's output space, but before B's own outputs and claims.

Claim indices in `block.claims` refer to positions in this extended vector:
- Index < `B.outputs.length`: **self-claim** (targets B's own output)
- Index >= `B.outputs.length`: **shared-resource claim** (targets an inherited output)

The extended vector exists only conceptually. It is not stored. After claims are applied, the surviving entries form the block's output space.

---

## Construction

Each block in the [total ordering](aggregation.md#total-ordering) transforms the UTXO state:

1. **Start** with the anchor's output space
2. **Apply subtrees** sequentially (in aggregate order): each subtree's transformation removes its claims from the current space and prepends its new outputs
3. **Prepend** the block's own outputs
4. **Apply** the block's own claims (removals from the extended vector)
5. **Result** is the block's output space

For leaf blocks (no aggregates), steps 1-2 simplify to just the anchor's output space.

### Self-Claiming

Because outputs are prepended before claims are applied, a block can claim its own outputs. A claim at index `i < outputs.length` is a **self-claim**: the output is produced and consumed atomically. Self-claimed outputs never appear in the output space. They serve contract fulfillment (producing a required output while immediately consuming it).

Self-claims are economically neutral (they net to zero in throughput balance) and do not participate in conflict detection.

---

## Claim Index Resolution

Given a claim at index `I` on block `B`, resolving it to the specific block and output that produced the claimed output:

### Leaf Block (no aggregates)

1. If `I < B.outputs.length`: self-claim. Resolves to `{block: B, outputIndex: I}`.
2. If `I >= B.outputs.length`: shared-resource claim. The target is at index `I - B.outputs.length` in the anchor's output space. Recurse into the anchor.

### Aggregation Block (has aggregates and cache)

1. If `I < B.outputs.length`: self-claim. Resolves to `{block: B, outputIndex: I}`.
2. Compute `R = I - B.outputs.length`.
3. Walk `B.aggregates` in **reverse** order (last aggregate first). For each aggregate `A`:
   - Read `A`'s `newOutputCount` from the cache (via `aggregateOutputCounts`).
   - If `R < A.newOutputCount`: the claim targets an output within A's subtree at index `R`. Recurse into A.
   - Else: `R -= A.newOutputCount`. Continue to next aggregate.
4. If `R` survives all aggregates: the claim targets index `R` in the anchor's output space. Recurse into the anchor.

This is the same algorithm used by the [output claims module](output-claims.md#migration) for claim migration.

### Using the Cache

The `aggregateOutputCounts` in the aggregation cache enables step 3 without loading the actual aggregate blocks. The cache provides the output counts needed for navigation. Only when the target aggregate is identified does that block need to be loaded.

For deep subtrees, this is recursive: each aggregate block also has a cache with its own `aggregateOutputCounts`, so resolution descends through the tree loading only the blocks on the path to the producing block.

---

## UTXO Set Computation

The UTXO set at a given block is its output space -- the clean, post-claim set of surviving outputs. Computing it:

### Direct Computation

Walk the block's transformation:
1. Recursively compute the anchor's output space.
2. Apply each aggregate subtree's transformation (remove claims, prepend new outputs).
3. Prepend own outputs, apply own claims.
4. Return the surviving set.

This is O(total blocks in ancestry) without caching.

### Cache-Accelerated Computation

With aggregation caches, skip subtree internals:
1. Compute the anchor's output space (recursively, also cache-accelerated).
2. For each aggregate, use its cache: remove `cache.claimMask` bits from the anchor space, prepend `cache.newOutputCount` outputs. The actual outputs can be retrieved from the aggregate's output space.
3. Prepend own outputs, apply own claims.

This is O(depth of anchor chain * average aggregates per block), which is O(log N) for balanced aggregation trees.

### Retrieving Specific Outputs

To retrieve the output at index `I` in a block's output space without computing the full set:

1. If `I < B.outputs.length - selfClaimCount`: it's one of B's own surviving outputs. Map through the self-claim gaps.
2. Else: use claim index resolution (above) to find which aggregate or ancestor produced it, then retrieve from that block.

---

## Index Transformation

Several operations require transforming an index from one block's output space to another's.

### Forward Transformation (Anchor to Descendant)

Given index `I` in block A's output space, find the corresponding index in descendant D's output space (where D anchors to A, possibly through intermediaries):

For each block B in the chain from A to D:
1. Apply B's claims: if B claims an output at or before index `I`, the index shifts. For each claim at position `P < I` (mapped to anchor space), decrement `I`. If B claims exactly `I`, the output was consumed -- it has no corresponding index in D's space.
2. Apply B's new outputs: `I += B.newOutputCount` (B's outputs are prepended, shifting all inherited indices up).

This is the **rebasing** operation used by the conflict module.

### Backward Transformation (Descendant to Anchor)

Given index `I` in block D's output space, find the corresponding index in ancestor A's output space:

This is the reverse of forward transformation: subtract new outputs, then add back claimed positions. The aggregation cache enables this without walking the full subtree.

---

## Interaction with Other Modules

| Module | How It Uses the Output Space |
|--------|------------------------------|
| [Conflict](conflict.md) | Compares claim masks (derived from claims against the anchor's output space) to detect double-spends |
| [Consensus](consensus.md) | Output space is the "state" that branches diverge on |
| [Output Claims](output-claims.md) | Migrates claim entries through the output space hierarchy to resolve which block produced each claimed output |
| [Block Creation](block-creation.md) | Constructs the extended vector, applies claims, produces the output space |
| [Aggregation](aggregation.md) | Caches the net transformation of subtrees for efficient output space computation |
| [Computation](computation.md) | Contracts read inputs from the output space (via claimed outputs and refs) |

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/Block.ts`](../../src/core/Block.ts) | `collectExtendedOutputs()` -- computes a block's output space, `getBlockClaimMask()` -- derives claim mask |
| [`src/core/ConflictModule.ts`](../../src/core/ConflictModule.ts) | Claim mask comparison, rebasing (index transformation) |
| [`src/core/OutputClaimModule.ts`](../../src/core/OutputClaimModule.ts) | Claim migration through the aggregation hierarchy |
