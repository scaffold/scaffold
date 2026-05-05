# Weight Propagation

This document specifies how weight propagates through the block graph so that any block's **descendant weight** can be computed without walking its full subtree. The result feeds conflict resolution: the heavier side of a conflict wins (see [consensus.md](consensus.md)).

The propagation rule is structural -- it operates only on `selfWeight`, `weightVector`, anchor links, and aggregator links. It does **not** read canonicality. (Canonicality is decided downstream by comparing descendant weights, so reading canonicality here would create a circular dependency.)

For where `selfWeight` and `weightVector` come from, see [weight.md](weight.md). For the chain-of-trees topology these rules ride on, see [dag.md](dag.md).

---

## What We're Computing

`descendantWeight(X)` is the total weight of work that depends on `X` being canonical -- the weight that would disappear if `X` lost its conflicts. It is the conflict-resolution score for `X` (combined with `X`'s own `selfWeight`/`weightVector`, depending on how the consensus layer composes them).

The set of dependents of `X` is exactly the blocks whose canonicality dependency chain (anchor edges + aggregate edges) passes through `X`:

- Every block with `X` in its anchor chain (anchor descendants).
- Every block that aggregates `X` directly or transitively, *and* their anchor descendants.

Counting all of that naively double-counts:

```
   X
  /|
 A B           A and B both anchor on X.
  \|           D aggregates both A and B.
   D           D's weight vector encodes A's and B's contributions to X (and X's ancestors)
               via the aggregation cache. Adding D + A + B would count A and B twice.
```

Aggregation already rolls up subtree contributions into the aggregator's `weightVector`, so once we choose to count an aggregator we must **not** also count the blocks it aggregates.

---

## Block-Local Inputs

Each block `B` exposes:

| Field | Meaning |
|-------|---------|
| `B.selfWeight` | The work `B` itself represents (verification cost). A scalar. Does **not** appear inside `B.weightVector`. |
| `B.weightVector[k]` | Weight of `B`'s aggregated subtree (the blocks whose markers `B`'s aggregation contract consumed) attributed to `B`'s `k`-th ancestor. `weightVector[0]` lands on `B.anchor`, `weightVector[1]` on `B.anchor.anchor`, and so on. Empty for leaf blocks. |
| `B.anchor` | The block `B` attaches to. |
| `B.aggregates` | Blocks `B` rolls up (already accounted for in `B.weightVector`). |

A block has at most one canonical aggregator (only one of any competing aggregators wins; the others lose by the aggregation rule in [consensus.md](consensus.md)). Likewise it has at most one canonical anchoring child along the spine. We exploit both invariants below.

---

## The Single Propagation Rule

Define `derivedWeightVector(B)`:

- `[0]` = total weight in `B`'s anchor subtree at chain blocks `B` AND deeper (a running accumulator -- `[0]` is the only "below-`B`" entry, so it absorbs everything that doesn't fit above).
- `[k]` for `k >= 1` = weight at `B`'s `k`-th ancestor (a single chain block).

Recurrence with `C*` = heaviest anchor child of `B`:

```
derivedWeightVector(B)[0] = B.selfWeight + derivedWeightVector(C*)[1] + derivedWeightVector(C*)[0]
derivedWeightVector(B)[k] = B.weightVector[k - 1] + derivedWeightVector(C*)[k + 1]   (k >= 1)
```

The asymmetry at `[0]` is what keeps weight from leaking out the bottom of the vector. `C*[1]` is `C*`'s contribution to `B` itself (so it lands at `B[0]`); `C*[0]` is `C*`'s already-accumulated weight at `C*` and deeper (also still in `B`'s subtree, so it also lands at `B[0]`). For `k >= 1` we just shift -- a single chain block has no deeper level to absorb.

**Why max over anchoring children:** Multiple blocks may anchor to `B`. Some of them compete (overlapping aggregations would conflict at consensus time); the protocol invariant is that only one becomes canonical. Genuinely independent parallel anchors *would* both survive, but the protocol assumes they get aggregated quickly into a single heavier block, at which point the aggregator wins the max. Picking the single heaviest child is conservative -- it never double-counts but transiently underweights truly-parallel work that hasn't been aggregated yet. That's the deliberate tradeoff.

**Update cost:** Each new block updates `derivedWeightVector` along its anchor chain. With balanced aggregation trees (the [DAG balancing constraint](dag.md#balancing) keeps the spine `O(log N)` deep), this is `O(log N)` per block.

---

## Querying `descendantWeight(X)`

Computing `derivedWeightVector(X)` only captures work below `X` in the anchor sense. But `X` may be an internal block of some tree -- aggregated by a parent, which may itself be aggregated, eventually rolling up to a tree root that lives on the chain. Work above `X` in the aggregator chain *also* depends on `X`. We need to walk in both directions.

The neighbors of `X` whose subtrees contain dependents of `X` are:

- `X`'s **parents** (blocks that aggregate `X`). Each parent's whole subtree depends on `X` through the aggregate rule.
- `X`'s **anchoring children** (blocks `C` with `C.anchor == X`). Each child's subtree depends on `X` through the anchor rule.

But these subtrees overlap. A parent `P` that aggregates `X` may itself be on, or be an ancestor of, an anchoring child's lineage. Concretely:

```
   X      Suppose X has anchoring child A (A.anchor == X), weight 100.
   |      A has its own anchoring child B (B.anchor == A), weight 50.
   A      P aggregates X and A, with selfWeight 5.
  /|      Then derivedWeight at A is 100 + 50 = 150.
 B P      derivedWeight at P (counted from P) covers X + A as a subtree
   |      = 5 (P's own) + 100 (A's contribution to X via P.weightVector)
            = 105 in the X-dependent total.
            But A by itself (without going through P) gives 150.
            Going through P would *lose* B's 50, since B is not in P's subtree.
```

If `P` aggregated `B` as well, `P` would carry 155 and beat `A`'s 150. As-is, `A` wins. **The right thing is to consider both `P` and `A` as candidate next steps and take whichever is heavier -- not to sum them.** Summing would double-count `X`'s contribution (once via `P.weightVector`, once via `A`'s subtree).

This is the same single-step rule as propagation, just walking the **canonicality dependency graph** instead of only the anchor graph. The dependency-graph neighbors of `X` are:

```
neighbors(X) = parents(X) ∪ anchoringChildren(X)
```

`descendantWeight(X)` is computed by picking the heaviest neighbor and recursing -- but in a way that correctly attributes weights from each kind of step. Concretely:

```
descendantWeight(X):
    candidates = []

    for P in parents(X):
        # P's subtree depends on X. The weight P contributes that lands
        # on X or above (i.e., on chain blocks between top_aggregator(X) inclusive
        # and P exclusive) is what counts -- the rest is above the aggregator chain.
        candidates.append( weightOfParentBranch(X, P) )

    for C in anchoringChildren(X):
        # C anchors to X, so all of derivedWeightVector(C) lands on X or its ancestors.
        # Specifically derivedWeightVector(C)[k] lands on X's (k-1)-th ancestor.
        # We want only contributions that land on X (k = 1) and below (k = 0).
        # k = 0 is C itself (descendant of X). k = 1 is X. k > 1 is above X.
        candidates.append( derivedWeightVector(C)[0] + derivedWeightVector(C)[1] )

    return max(candidates, default = 0)
```

Where `weightOfParentBranch(X, P)` walks `X`'s aggregator chain up to `P`, accumulating the sub-aggregators' `selfWeight` plus, at each level `i` of ascent, that aggregator's `weightVector[0..i]` -- the entries that attribute back to chain blocks between `top_aggregator(X)` (inclusive) and the current aggregator (exclusive). Past index `i` we'd be attributing weight *above* `X`'s tree root, which doesn't depend on `X`.

> **In words:** At every step we have a single budget of "work that disappears if `X` loses." We pick the neighbor whose subtree carries the most of that budget and follow it. The choice is a single max -- never a sum -- so each block's weight is counted exactly once.

---

## Worked Examples

### Diamond avoided by max

```
        X (selfWeight 1)
       /|
      A B
       \|
        D (aggregates {A, B}, selfWeight 5, weightVector encodes A+B contributions)
```

Naive forward propagation would count `A` and `B` once via `D` and once directly. The rule above considers the candidates:

- via anchoring child `A`: derivedWeight from `A`'s side
- via anchoring child `B`: derivedWeight from `B`'s side
- via parent `D` of any block in the diamond that has `D` as a parent

and takes the single max -- no double count.

### Chained subtree, all co-aggregated

```
   X (selfWeight 10)         P aggregates {X, A, B}, selfWeight 5.
   |                         X's contribution to its anchor lives in P.weightVector[1].
   A (selfWeight 20)         A's contribution to X lives in P.weightVector[0].
   |                         B's contribution to A and X lives in P.weightVector[0..1].
   B (selfWeight 30)
```

To compute `descendantWeight(X)` via the parent branch through `P`:

```
walk X -> P (one aggregator step)
   add P.selfWeight = 5
   add P.weightVector[0]  # weight that lands on X = 20 (from A) + 30 (from B)
                                                      via B's wV[0] entry
                          = ... = 50

   = 5 + 50 = 55 from this branch
```

The anchoring-child branches give `descendantWeight` going through `A` directly: `20 (A.selfWeight) + 30 (via B as A's anchoring child)` -- which carries `A`'s own subtree but no `P.selfWeight` boost.

`max(55, 50, ...)` = 55 wins, so we use the `P` branch.

### Competing aggregators (Joel's example)

```
   X (selfWeight 0)
   |
   A (selfWeight 100, anchoring child of X)
   |
   B (selfWeight 50, anchoring child of A)

   P aggregates {X, A}, selfWeight 5.
   P' aggregates {X, A, B}, selfWeight 5.
```

Candidate scores at `X`:

- through anchoring child `A`: 100 (A) + 50 (B) = **150**
- through parent `P`: P.selfWeight 5 + (A's contribution that lands on X via P.weightVector) 100 = **105**.  P doesn't see B, so B's 50 is missing.
- through parent `P'`: 5 + 100 + 50 = **155**.

`max = 155`, so `P'` wins. If `P'` didn't exist, `A`'s 150 would beat `P`'s 105 and `A` would win.

This is exactly the no-summing invariant: we never combine `P` and `A` because their subtrees overlap in the X-dependent set.

---

## Module Boundary

The propagation rule is a pure module. Its provider exposes only:

- `selfWeight(B)`
- `weightVector(B)`
- `anchor(B)`
- `anchoringChildren(B)` -- blocks `C` with `C.anchor == B`
- `parents(B)` -- blocks that have `B` in their `aggregates`

It does **not** read canonicality, conflicts, or verified weight separately -- it operates on whatever weights the provider returns (declared today, sampling-corrected later). The downstream consensus layer feeds the result into conflict resolution.

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/NodeWeightsModule.ts`](../../src/core/NodeWeightsModule.ts) | Pure logic: `derivedWeightVector` propagation, `descendantWeight(X)` query, single-max walk |
| [`src/core/NodeWeightsService.ts`](../../src/core/NodeWeightsService.ts) | Adapter from `BlockStore` + `DraftStore` to the propagation provider. Drafts participate as phantom blocks (anchor / aggregates derived via `pickAnchorForClaims`). When `SamplingService` is wired, blocks' `selfWeight` and `weightVector` are scaled by the per-block weight factor. Memoises `derivedWeightVector` and `descendantWeight` per version; invalidated on store add, draft add / transition, and sampling weight-factor change. |
| [`src/core/ConsensusService.ts`](../../src/core/ConsensusService.ts) | Wires `effectiveWeight = nodeWeights.selfWeight + nodeWeights.descendantWeight` into `ConsensusModule`'s conflict-resolution path. |
| [`tests/NodeWeights.test.ts`](../../tests/NodeWeights.test.ts) | Unit tests on the pure module: diamond, chained co-aggregation, competing aggregators, multi-tree spine. |
| [`tests/NodeWeightsService.test.ts`](../../tests/NodeWeightsService.test.ts) | End-to-end through real `BlockStore` / `DraftStore`: aggregation cache decoding, drafts as phantom blocks, cache invalidation. |
