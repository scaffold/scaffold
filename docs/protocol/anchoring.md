# Anchoring Module

The anchoring module specifies **how outputs are addressed across blocks** -- given an output on one block, find its index in another block's output space. The single core algorithm is `rebaseOutputIndex`.

Anchor selection (choosing where a draft block attaches and what it aggregates) lives in [placement.md](placement.md). The two compose: placement returns an anchor, then `rebaseOutputIndex` lowers each `ClaimRef` into a concrete claim index in the constructed block's output space.

---

## Standard Output Space

Every block has an **output space** -- the set of outputs visible at that block, before the block's own claims are applied. This is the space that the block's `claims` indices reference, and the space exposed to any block that anchors to it (after the block's claims remove consumed outputs).

For a block B with anchor P and aggregates [S_1, S_2, ..., S_K] (ordered, S_K applied last):

```
B.outputSpace = [
    B.outputs,                                          // B's own outputs (before self-claims)
    S_K.outputSpace,                                    // last subtree's full output space
    S_{K-1}.outputSpace \ S_K.claims,                   // second-to-last, minus last's claims
    ...
    S_1.outputSpace \ (S_2 ∪ ... ∪ S_K).claims,        // first subtree, minus all later claims
    P.postClaimOutputSpace \ (S_1 ∪ ... ∪ S_K).claims  // anchor outputs, minus all subtree claims
]
```

Where `P.postClaimOutputSpace` is P's output space after P's own claims have been applied -- i.e., what P exposes to its anchor-children.

Key properties:

- The output space exists **before** the block's own claims. B's `claims` field references indices in this space.
- The **post-claim output space** (what anchor-children see) is the output space minus B's own claims.
- Subtrees are applied in order. Later subtrees can claim outputs from earlier subtrees.
- Subtrees can form chains among themselves: if S_2 anchors to S_1, S_2's claims reference S_1's output space. The aggregation handles this by processing subtrees in dependency order.

### Claim Mask

The **claim mask** of a block B is a bit vector over B's anchor's output space. It encodes which anchor outputs are consumed by B's subtrees. It does **not** include B's own claims -- those are stored separately in `B.claims`.

This separation matters for rebasing: when stepping forward from B's anchor to B, you apply B's claim mask to find surviving anchor outputs. When stepping forward from B to a block C that anchors to B, you apply B's own claims.

### Subtrees with Different Anchors

Subtrees do not all need to share the same anchor. If B aggregates S_1 (which anchors to P) and S_2 (which anchors to S_1), the subtree ordering must respect dependencies: S_1 is processed before S_2 (since S_2 depends on S_1). S_2's claims reference S_1's output space, and when S_2 is applied, it removes from S_1's section and prepends its own outputs.

This means aggregation can handle chains: if blocks P, Q, R form a chain (Q anchors to P, R anchors to Q), a single aggregation block can aggregate both Q and R with anchor P. The subtree processing order is Q first, then R.

---

## rebaseOutputIndex

### Interface

```typescript
function rebaseOutputIndex(
    block: Block,
    outputIndex: number,
    ontoBlock: Block,
): number | null
```

Given an output at `block.outputs[outputIndex]` (an output in `block`'s own outputs array), find its position in `ontoBlock`'s output space. Returns null if the output was consumed by an intermediate block.

This works in **both directions** -- `ontoBlock` can be an ancestor or a descendant of `block`, and the path can go through anchor links and/or aggregation links.

### Path Finding

Before rebasing, we need a path from `block` to `ontoBlock`. The path is a sequence of steps, each either an anchor step or an aggregation step, either forward or backward.

```
1. Build the extended ancestry of `block`:
   Walk anchor links back to genesis: block → block.anchor → ... → genesis.
   At each step, also record all aggregators (blocks that aggregate this block,
   found by querying the block store).

2. Build the extended ancestry of `ontoBlock` the same way.

3. Find the connection:
   - Check if `block` is in `ontoBlock`'s anchor chain (or vice versa).
   - Check if any aggregator of `block` appears in `ontoBlock`'s ancestry.
   - Check if any aggregator of `ontoBlock` appears in `block`'s ancestry.
   - Check for a common ancestor reachable via both paths.

4. Construct the path:
   A sequence of (direction, stepType, block) tuples:
   - direction: forward or backward
   - stepType: anchor or aggregate
   - block: the block being stepped through
```

### The Four Cases

Each step in the path is one of four cases. In all cases, we start with an index `i` in the "source" block's output space and produce an index in the "target" block's output space.

#### Case 1: Forward from A.anchor to A (anchor step forward)

Moving from A's anchor's output space into A's output space. The index `i` references an output in A.anchor's post-claim output space.

```
Apply A's subtree claim masks:
    if claimMask(A).get(i):
        return null   // output was consumed by A's subtrees

    claimedBefore = popcount(claimMask(A)[0..i))
    survivingIndex = i - claimedBefore

    return A.ownOutputCount + A.totalSubtreeOutputs + survivingIndex
```

The output lands in the "surviving anchor outputs" zone of A's output space, offset past A's own outputs and all subtree outputs.

#### Case 2: Forward from A.aggregates[n] to A (aggregation step forward)

Moving from aggregate S_n's output space into A's output space. The index `i` references an output in S_n's output space.

Later subtrees (S_{n+1}, ..., S_K) may have claimed outputs from S_n. We must trace through those claims:

```
currentIndex = i

for m = n+1 to K:
    S_m = A.aggregates[m]

    if S_m anchors to S_n or a descendant of S_n:
        // S_m's claims reference S_n's (or a descendant's) output space
        // Check if S_m claims the output at currentIndex
        if S_m.claimMask.get(currentIndex):
            return null   // consumed by a later subtree

        // Adjust index: S_m removes some outputs and prepends its own
        claimedBefore = popcount(S_m.claimMask[0..currentIndex))
        survivingIndex = currentIndex - claimedBefore
        currentIndex = S_m.ownOutputCount + S_m.totalSubtreeOutputs + survivingIndex

// Now currentIndex is in the subtree section of A's output space
// Add offset for A's own outputs and earlier subtrees
offset = A.ownOutputCount + sum(outputCounts of subtrees after S_n)

return offset + currentIndex
```

Note: the exact offset computation depends on subtree ordering. The key idea is that each later subtree may consume from earlier subtrees, and the surviving outputs shift forward.

#### Case 3: Backward from A to A.anchor (anchor step backward)

Moving from A's output space back to A's anchor's post-claim output space. The index `i` references a position in A's output space.

```
if i < A.ownOutputCount:
    return null   // A's own output, doesn't exist in anchor's space

if i < A.ownOutputCount + A.totalSubtreeOutputs:
    return null   // subtree output, not directly in anchor's space
                  // (caller should step backward through the subtree instead)

// i is in the surviving anchor section
survivingIndex = i - A.ownOutputCount - A.totalSubtreeOutputs

// Inverse-map: find the original anchor index for the nth surviving output
// This is mapSurvivingToOriginal: count unclaimed slots in claimMask(A)
count = 0
for j = 0 to claimMask(A).length:
    if not claimMask(A).get(j):
        if count == survivingIndex:
            return j
        count++

return null   // survivingIndex out of range
```

#### Case 4: Backward from A to A.aggregates[n] (aggregation step backward)

Moving from A's output space back to aggregate S_n's output space. The index `i` must be in S_n's section of A's output space.

```
// Determine if i falls in S_n's section
// S_n's section starts after A's own outputs and all later subtrees
sectionStart = A.ownOutputCount + sum(outputCounts of subtrees after S_n)
sectionEnd = sectionStart + outputCount(S_n)

if i < sectionStart or i >= sectionEnd:
    return null   // not in S_n's section

localIndex = i - sectionStart

// Inverse-apply later subtrees' claims to recover S_n's original index
// Walk backward from S_K to S_{n+1}, undoing each transformation

for m = K down to n+1:
    S_m = A.aggregates[m]

    if S_m anchors to S_n or a descendant of S_n:
        // S_m prepended its outputs and removed claims
        // Undo: remove the prepended outputs, then expand the surviving range

        if localIndex < S_m.ownOutputCount + S_m.totalSubtreeOutputs:
            return null   // this output is from S_m, not from S_n

        survivingIndex = localIndex - S_m.ownOutputCount - S_m.totalSubtreeOutputs

        // Expand: insert back the claimed slots
        count = 0
        for j = 0 to S_m.claimMask.length:
            if not S_m.claimMask.get(j):
                if count == survivingIndex:
                    localIndex = j
                    break
                count++

return localIndex
```

### Chaining Steps

For a multi-hop path, chain the steps. Each step transforms an index from one block's output space to the next block's output space. If any step returns null, the output was consumed and the overall result is null.

```
function rebaseOutputIndex(block, outputIndex, ontoBlock):
    path = findPath(block, ontoBlock)
    currentIndex = outputIndex

    for each step in path:
        match step:
            case (forward, anchor, B):
                currentIndex = forwardAnchorStep(currentIndex, B)
            case (forward, aggregate(n), B):
                currentIndex = forwardAggregateStep(currentIndex, B, n)
            case (backward, anchor, B):
                currentIndex = backwardAnchorStep(currentIndex, B)
            case (backward, aggregate(n), B):
                currentIndex = backwardAggregateStep(currentIndex, B, n)

        if currentIndex == null:
            return null

    return currentIndex
```

### Handling B.anchor's Own Claims

When stepping forward from B.anchor to B (Case 1), we work with B.anchor's **post-claim** output space. That means B.anchor's own claims have already been applied -- the outputs B.anchor consumed are already removed.

But `rebaseOutputIndex` takes an index into `block.outputs[]` -- the block's OWN outputs, which exist in the **pre-claim** output space. The initial index is always relative to the block's own outputs array.

For the first hop of a forward path (from `block` to its anchor-child), the index `outputIndex` is in `block`'s own-output zone (zone 0 of `block`'s output space). To express it in `block`'s post-claim output space (what anchor-children see), we need to account for any of `block`'s own claims that fall before this index:

```
// Initial setup: convert outputIndex from own-outputs position
// to post-claim-output-space position
postClaimIndex = outputIndex
for each claim in block.claimIndices:
    if claim < outputIndex:
        postClaimIndex--   // a claim before us was removed, our position shifts
    if claim == outputIndex:
        return null        // this output was self-claimed, consumed
```

Alternatively, if we define `rebaseOutputIndex` as always starting from the pre-claim output space (which includes own outputs at their natural indices), then the first step is to convert to post-claim before continuing to anchor-children. The exact API design is an implementation choice.

---

## How placement and rebaseOutputIndex Connect

The two algorithms compose to form the block construction pipeline:

1. **[Placement](placement.md)** determines where the block attaches (its anchor) and what it aggregates.
2. **`rebaseOutputIndex`** maps each `ClaimRef { block, outputIndex }` to an integer index in the constructed block's output space.

```
For each ClaimRef { block: X, outputIndex: i }:
    claimIndex = rebaseOutputIndex(X, i, constructedBlock)
    if claimIndex == null:
        error: output not available
```

Since the constructed block doesn't exist yet, `rebaseOutputIndex` must work with the block's known structure (anchor, aggregates, own outputs) without a hash. The "onto block" is the block being constructed -- its output space is computable from its components.

---

## Edge Cases

### 1. Aggregating blocks from different depths

B anchors to A, C anchors to B. Aggregating both B and C with anchor A:
- Subtree processing order: B first, then C (C depends on B).
- B's claims are against A's output space.
- C's claims are against B's output space (B's outputs + A's surviving outputs).
- After processing B: [B.outs | A.outs \ B.claims].
- After processing C: [C.outs | B.outs \ C.B_claims | A.outs \ B.claims \ C.A_claims].

### 2. Subtree claims an output from another subtree

S_1 produces output X. S_2 anchors to S_1 and claims X. When aggregated:
- S_1 is processed first, X is in the vector.
- S_2 is processed next, claims X, removes it, prepends S_2's outputs.
- X no longer survives in the final output space.
- A resolved claim on X through S_1 would fail (consumed by S_2).
- A resolved claim on X through S_2 would succeed (S_2 claimed it).

### 3. Output claimed by intermediate block

Rebasing output 3 of block X forward to block Z, where intermediate block Y (between X and Z) claims output 3. `forwardAnchorStep` returns null at Y. The output is not available at Z.

### 4. Circular aggregation

Block A aggregates B, block B aggregates A. This is impossible for published blocks (hash circularity) but must be rejected for drafts. The path-finding algorithm would loop -- detect and error.

### 5. No common path

Two blocks with no common ancestry (different genesis). Path finding fails -- error.

### 6. Multiple paths between blocks

Block X can reach block Y via the anchor chain OR via aggregation. Different paths may give different results (one may show the output as consumed, another as available). The algorithm should use the shortest path, or the path through the aggregation structure that matches the constructed block's aggregates list.

### 7. Forward rebase into subtree zone

When rebasing forward from A.anchor to A, the index lands in the surviving-anchor zone. If we need to continue forward into A's anchor-child C, C's subtrees and claims operate on A's post-claim output space. The surviving-anchor index from A's output space must first be adjusted by A's own claims before entering C's transformation.

### 8. Genesis outputs

Genesis has no anchor (ZERO_HASH) and no aggregates. Its output space is simply its `outputs` array. Rebasing from genesis is always the starting point -- `outputIndex` maps directly.

---

## Test Cases

### T1: Simple forward rebase through one block

```
Genesis: outputs [g0, g1, g2]
A anchors to Genesis: outputs [a0], claims [g1]
  A.claimMask = [0, 1, 0] (claims g1 from genesis)

rebaseOutputIndex(Genesis, 0, A):
  Path: forward anchor step through A
  g0 not claimed by A. claimedBefore(0) = 0. survivingIndex = 0.
  result = 1 + 0 + 0 = 1   (A.ownOutputCount=1, totalSubtreeOutputs=0)

rebaseOutputIndex(Genesis, 1, A):
  g1 IS claimed by A. return null.

rebaseOutputIndex(Genesis, 2, A):
  g2 not claimed. claimedBefore(2) = 1. survivingIndex = 1.
  result = 1 + 0 + 1 = 2
```

### T2: Forward rebase through two blocks

```
Genesis: outputs [g0, g1]
A anchors to Genesis: outputs [a0], claims [] (no claims)
B anchors to A: outputs [b0], claims [a0]  (claims a0, index 0 in A's post-claim space)
  B.claimMask = [1, 0, 0] in A's output space (claims a0)

rebaseOutputIndex(Genesis, 0, B):
  Step 1: forward through A.
    g0 not claimed. claimedBefore=0. survivingIndex=0.
    index = 1 + 0 + 0 = 1 (in A's output space)
  Now need post-claim transform through A: A has no own claims, so index stays 1.
  Step 2: forward through B.
    index 1 in A's post-claim space. B.claimMask.get(1) = 0.
    claimedBefore(1) = 1 (bit 0 is set). survivingIndex = 0.
    result = 1 + 0 + 0 = 1 (B.ownOutputCount=1)

rebaseOutputIndex(Genesis, 0, B) = 1
  B's output space: [b0, g0, g1]. Position 1 = g0. Correct.
```

### T3: Backward rebase

```
Genesis: outputs [g0, g1, g2]
A anchors to Genesis: outputs [a0], claims [g1]
  A.claimMask = [0, 1, 0]

rebaseOutputIndex(A, 0, Genesis):
  a0 is A's own output (index 0 < ownOutputCount=1).
  Path: backward anchor step.
  But a0 doesn't exist in Genesis's output space. return null.

Rebasing a surviving anchor output:
  Index 2 in A's output space = g2 (surviving anchor zone).
  backwardAnchorStep(2, A):
    survivingIndex = 2 - 1 - 0 = 1
    mapSurvivingToOriginal(1, [0,1,0]):
      j=0: not claimed, count=0 (not 1)
      j=1: claimed, skip
      j=2: not claimed, count=1. Match! return 2.
  rebaseOutputIndex result = 2. g2 is at index 2 in Genesis. Correct.
```

### T4: Forward through aggregation

```
Genesis: outputs [g0, g1]
S1 anchors to Genesis: outputs [s1_0], claims [g0]
S2 anchors to Genesis: outputs [s2_0], claims [g1]
D aggregates [S1, S2], anchor = Genesis, outputs [d0]

rebaseOutputIndex(S1, 0, D):
  s1_0 is S1's own output.
  Path: forward aggregate step (S1 is D.aggregates[0]).
  Check if later subtrees (S2) claim s1_0:
    S2 anchors to Genesis, not to S1, so S2's claims don't affect S1's outputs.
  offset = D.ownOutputCount + outputCount(S2) = 1 + outputCount(S2)
  result = offset + 0

  D's output space: [d0 | S2.outs | S1.outs_adjusted | Genesis.outs_adjusted]
  If S2 doesn't claim from S1: [d0, s2_0, s1_0, (no surviving genesis outs)]
  s1_0 is at position 2. So result = 2.
```

### T5: Aggregation with chained subtrees

```
Genesis: outputs [g0, g1, g2]
B anchors to Genesis: outputs [b0, b1], claims [g0]
C anchors to B: outputs [c0], claims [b0]
D aggregates [B, C], anchor = Genesis, outputs [d0]

Subtree processing order: B first (C depends on B).
After B: [b0, b1, g1, g2]  (g0 removed by B)
After C: [c0, b1, g1, g2]  (b0 removed by C, c0 prepended)

D's output space: [d0, c0, b1, g1, g2]

rebaseOutputIndex(B, 1, D):  (b1, B's second output)
  Path: forward aggregate step (B is D.aggregates[0]).
  Check later subtree C: C anchors to B, so C's claims affect B's outputs.
    C claims b0 (index 0 in B's output space). b1 is index 1, not claimed.
    claimedBefore(1) = 1. survivingIndex = 0.
    currentIndex = C.ownOutputCount + C.totalSubtreeOutputs + 0 = 1 + 0 + 0 = 1
  offset = D.ownOutputCount + outputCount(C) = 1 + ... hmm

  Actually D's output space is [d0 | C.outputSpace | B.outputSpace_adjusted | ...]
  C is last subtree (applied last), so C's section comes first after D's own outputs.
  C.outputSpace = [c0, b1, g1, g2] (C's own output + surviving from B/Genesis)
  b1 is at position 1 in C.outputSpace.
  In D's output space: offset = 1 (d0), so b1 is at position 1 + 1 = 2.
  D.outputSpace = [d0, c0, b1, g1, g2]. Position 2 = b1. Correct.
```

### T6: Backward through aggregation

```
Genesis: outputs [g0, g1]
S1 anchors to Genesis: outputs [s1_0]
D aggregates [S1], anchor = Genesis, outputs [d0]

D's output space: [d0, s1_0, g0, g1]  (assuming S1 doesn't claim anything)

rebaseOutputIndex(D, 0, S1):
  d0 is D's own output (index 0). Not in S1's space. return null.

Index 1 in D's output space = s1_0.
  backwardAggregateStep(1, D, 0):  (aggregate index 0 = S1)
    sectionStart = D.ownOutputCount = 1
    sectionEnd = 1 + outputCount(S1)
    1 >= sectionStart and 1 < sectionEnd
    localIndex = 1 - 1 = 0
    No later subtrees to inverse-apply.
    result = 0  (index 0 in S1's output space = s1_0). Correct.
```

### T7: Bidirectional -- rebase between siblings

```
Genesis: outputs [g0]
A anchors to Genesis: outputs [a0]
B anchors to Genesis: outputs [b0]

rebaseOutputIndex(A, 0, B):
  a0 is A's own output. A and B are siblings (both anchor to Genesis).
  Path: backward from A to Genesis, then forward from Genesis to B.
  Step 1: backward anchor step from A to Genesis.
    a0 is A's own output (index 0 < ownOutputCount=1). return null.
  a0 doesn't exist in B's output space. Correct -- a0 is A's output, not B's.

rebaseOutputIndex(Genesis, 0, B):
  Path: forward anchor step through B.
  g0 not claimed by B. claimedBefore=0. survivingIndex=0.
  result = 1 + 0 + 0 = 1.
  B.outputSpace = [b0, g0]. Position 1 = g0. Correct.
```

---

## Relation to Existing Modules

### ConflictModule

`ConflictModule.rebase` performs the same transformation as `rebaseOutputIndex` but on entire bit vectors (all claimed outputs at once). The two should share the underlying chain-walking and per-step transformation logic. `rebaseOutputIndex` is the single-output specialization.

`computeNetClaimMask` and `mapSurvivingToOriginal` are used by both algorithms and should be factored into shared utilities.

### BlockCreationModule

Anchor selection feeds `BlockBuilderModule.build`:

1. [Placement](placement.md) computes the anchor.
2. `rebaseOutputIndex` maps each `ClaimRef` to an integer index in the constructed block's output space.
3. The result is fed to `buildBlock` for validation (throughput, weight vector, etc.).

### Draft Blocks

Draft solidification calls placement to derive the anchor. See [Draft Blocks](draft-blocks.md) and [Placement](placement.md).

---

## Open Questions

### Draft-to-Draft Dependencies

If draft D1's phantom anchor creates an output space, and draft D2 wants to reference D1's outputs, D2 would need to include D1 in its include set. But D1 isn't a real block -- the path-finding algorithm can't walk through it. Full support for draft-to-draft chains requires extending the path-finding algorithm to handle draft blocks, which adds complexity.

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/AnchoringModule.ts`](../../src/core/AnchoringModule.ts) | `rebaseOutputIndex`, path finding |
| [`src/core/OutputMapping.ts`](../../src/core/OutputMapping.ts) | Shared utilities: `mapSurvivingToOriginal`, `mapOriginalToSurviving`, `ClaimRef` |
| [`src/core/Block.ts`](../../src/core/Block.ts) | `claims` field on `Block` interface |
| [`src/core/BlockCreationModule.ts`](../../src/core/BlockCreationModule.ts) | Downstream consumer (imports `mapSurvivingToOriginal`) |
| [`src/core/ConflictModule.ts`](../../src/core/ConflictModule.ts) | Shares rebase machinery (imports `mapSurvivingToOriginal`) |
| [`tests/AnchoringModule.test.ts`](../../tests/AnchoringModule.test.ts) | Tests for output mapping and rebase (T1-T7) |
