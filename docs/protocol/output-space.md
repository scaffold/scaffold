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
     anchor's surviving outputs (after subtrees' claims)]
```

Genesis has no anchor. Its output space is simply its own outputs.

---

## Extended Vector

The **extended vector** is a transient construction used during claim resolution. It is the block's own outputs prepended to the inherited outputs, **before** claims are applied:

```
Block B's extended vector:
    [B's own outputs (all, including those about to be self-claimed),
     aggregate[-1]'s new outputs,
     ...,
     aggregate[0]'s new outputs,
     anchor's surviving outputs (after subtrees' claims)]
```

The "anchor's surviving outputs" are the anchor's output space with aggregate subtree claims removed. This is the state after all aggregate subtrees have applied their transformations to the anchor's output space, but before B's own outputs and claims.

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

### `newOutputCount` and Self-Claims

A block's `newOutputCount` is the number of new surviving outputs it contributes:

```
newOutputCount = outputs.length - selfClaimCount
```

This is the count of outputs that appear in the block's output space but not in the anchor's output space. Parent blocks use this value to navigate the extended vector -- self-claimed outputs are invisible to parents.

---

## Claim Index Resolution

Given a claim at index `I` on block `B`, resolving it to the specific block and output that produced the claimed output requires two mutually recursive operations:

### `resolveClaimIndex(block, I)` -- Extended Vector Resolution

Resolves index `I` in block's extended vector (pre-claims):

1. If `I < B.outputs.length`: self-claim. Resolves to `{block: B, outputIndex: I}`.
2. Compute `R = I - B.outputs.length`.
3. Walk `B.aggregates` in **reverse** order (last aggregate first). For each aggregate `A`:
   - Read `A`'s subtree `newOutputCount` from the cache (via `aggregateOutputCounts[i]`).
   - If `R < newOutputCount`: the claim targets an output within A's output space at index `R`. Call `resolveOutputSpaceIndex(A, R)`.
   - Else: `R -= newOutputCount`. Continue to next aggregate.
4. If `R` survives all aggregates: `R` indexes into the **surviving** anchor outputs (post-subtree-claims). Map through the aggregate subtree claim mask to get the original anchor output space index, then call `resolveOutputSpaceIndex(anchor, mappedIndex)`.

### `resolveOutputSpaceIndex(block, S)` -- Output Space Resolution

Resolves index `S` in block's output space (post-claims):

1. Map `S` through the block's claim gaps to get the extended vector index `E`. This reverses the claim removals: skip over claimed positions to find the `S`-th surviving entry.
2. Return `resolveClaimIndex(block, E)`.

### Why Two Functions

The extended vector includes all outputs (including those about to be self-claimed), while the output space has self-claimed outputs removed. When navigating into an aggregate's outputs, you enter its output space (post-claims). To continue resolution within that block, you need to map back to the extended vector. The two functions alternate: extended vector -> output space (descend into aggregate) -> extended vector (map through claims) -> and so on.

### Step 4: The Anchor Surviving Mapping

The anchor's entries in the extended vector are the anchor's output space with subtree-claimed outputs removed. An index `R` into this surviving portion does NOT directly correspond to anchor output space index `R`. The aggregate subtree claim mask specifies which anchor output space entries were consumed. To resolve:

```
originalAnchorIdx = mapSurvivingToOriginal(R, aggregateSubtreeClaimMask)
```

Where `mapSurvivingToOriginal` skips over claimed positions to find the `R`-th surviving entry's original index.

---

## Worked Example

Consider a block B with 3 outputs and self-claims at [0], anchored to G with 5 outputs:

```
B: outputs=[x0, x1, x2], claims=[0], anchor=G
G: outputs=[o0, o1, o2, o3, o4]

B's extended vector: [x0, x1, x2, o0, o1, o2, o3, o4]
B claims [0] -> removes x0 (self-claim)
B's output space: [x1, x2, o0, o1, o2, o3, o4]
B.newOutputCount = 3 - 1 = 2
```

Now block D aggregates B with anchor G:

```
D: outputs=[d0], aggregates=[B], aggregateOutputCounts=[2], anchor=G

D's extended vector:
    [d0,              -- own output (index 0)
     x1, x2,          -- B's new outputs (first 2 of B's output space)
     o0, o1, o2, o3, o4]  -- G's surviving (no subtree claims against G)
```

Resolving index 1 in D's extended vector:
1. `1 >= D.outputs.length (1)`, so `R = 0`
2. Walk aggregates in reverse: B has `newOutputCount = 2`
3. `R (0) < 2`, so call `resolveOutputSpaceIndex(B, 0)`
4. Map through B's claims [0]: `mapSurvivingToOriginal(0, [0]) = 1`
5. `resolveClaimIndex(B, 1)` -> `1 < 3` -> `{B, 1}` (which is x1)

The self-claimed output x0 is invisible to D. D's index 1 resolves to B's second output (x1), not B's first (x0).

---

## Inverse: Computing Claim Indices

The inverse operations (`computeClaimIndex` and `computeOutputSpaceIndex`) work symmetrically:

- **`computeClaimIndex(block, target)`**: Given a known output `{targetBlock, outputIndex}`, find its index in block's extended vector. Searches own outputs, then each aggregate's output space (only the "new" portion), then the anchor.
- **`computeOutputSpaceIndex(block, target)`**: Find the output space index by computing the extended vector index and mapping through claims.

These are used during draft solidification to convert resolved claims `{block, outputIndex}` into claim indices for the final block.

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
2. For each aggregate, use its cache: remove `cache.claimMask` entries from the anchor space, prepend `cache.newOutputCount` outputs. The actual outputs can be retrieved from the aggregate's output space.
3. Prepend own outputs, apply own claims.

This is O(depth of anchor chain * average aggregates per block), which is O(log N) for balanced aggregation trees.

---

## Claim Masks

A **claim mask** is a sorted array of anchor output space indices that a block's subtree claims. It captures the net effect of the subtree on the anchor's outputs.

For a leaf block: the claim mask is the set of non-self claim indices mapped to the anchor's output space.

For an aggregation block: the claim mask is the union of all aggregate subtree claim masks, plus the block's own non-self, non-aggregate claims mapped to the anchor's output space (accounting for the subtree claim mask when mapping through surviving positions).

Two blocks conflict if their claim masks overlap (share any index). This is the foundation of [conflict detection](conflict.md).

---

## Interaction with Other Modules

| Module | How It Uses the Output Space |
|--------|------------------------------|
| [Conflict](conflict.md) | Compares claim masks to detect double-spends |
| [Consensus](consensus.md) | Output space is the "state" that branches diverge on |
| [Output Claims](output-claims.md) | Migrates claim entries through the output space hierarchy to resolve which block produced each claimed output |
| [Block Creation](block-creation.md) | Validates claim indices and throughput balance against the extended vector |
| [Aggregation](aggregation.md) | Caches the net transformation of subtrees for efficient output space computation |
| [Computation](computation.md) | Contracts read inputs from the output space (via claimed outputs and refs) |

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/OutputSpace.ts`](../../src/core/OutputSpace.ts) | Pure output-space operations: resolution, inverse, claim masks, ordering, UTXO computation |
| [`src/core/Block.ts`](../../src/core/Block.ts) | `AggregationData` type, `getBlockClaimMask()`, `getBlockNewOutputCount()` (legacy, delegates to OutputSpace) |
| [`src/core/ConflictModule.ts`](../../src/core/ConflictModule.ts) | Claim mask comparison, rebasing (index transformation) |
| [`src/core/OutputClaimModule.ts`](../../src/core/OutputClaimModule.ts) | Claim migration through the aggregation hierarchy |
