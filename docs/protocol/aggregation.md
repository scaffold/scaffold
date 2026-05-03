# Aggregation

Aggregation rolls up multiple blocks into a single block that represents their collective contribution. It serves two purposes: structural compression of the DAG, and caching of output-space transformations so that claim resolution and UTXO computation can skip subtree traversal.

This document specifies how aggregation works, the total ordering it defines, and the relationship between the structural `aggregates` field and the aggregation contract output (cache).

For the output-space model that aggregation operates on, see [output-space.md](output-space.md). For how aggregation interacts with conflict detection, see [conflict.md](conflict.md). For the chain-of-trees topology, see [dag.md](dag.md).

---

## Total Ordering

Aggregation defines a **total ordering** on all blocks preceding a given tip. This ordering converts the DAG into a sequential chain, enabling a simple model of UTXO-space evolution: each block in the ordering adds outputs then applies claims, transforming the UTXO state.

```
ordering(tip) =
    if tip is genesis: [tip]
    else: [...ordering(tip.anchor),
           ...tip.aggregates.flatMap(a => subtreeFrom(a, tip.anchor)),
           tip]

subtreeFrom(block, base) =
    if block == base: []
    else: [...subtreeFrom(block.anchor, base),
           ...block.aggregates.flatMap(a => subtreeFrom(a, base)),
           block]
```

`subtreeFrom(block, base)` follows **both** anchor chains and aggregate chains, stopping at `base`. This correctly handles linear chains: `subtreeFrom(D, A)` where D->C->B->A yields `[B, C, D]`, following the anchor chain from D back to A.

### Properties

1. **No double-counting**: `subtreeFrom` excludes `base` and everything below it. The anchor's ordering is included exactly once at the top level.
2. **Deterministic**: given the same block graph, the ordering is always the same.
3. **Composable**: the subtree ordering of a block is independent of which parent aggregates it -- it depends only on the block's own structure and the base.

### Aggregate Ordering

Within a block's `aggregates` array, order matters. It determines the claim index layout in the extended vector (see [output-space.md](output-space.md)). Aggregates are ordered by descending subtree weight (heaviest first). This ordering is deterministically verifiable from the subtrees' weight vectors.

---

## The `aggregates` Field

The `aggregates` field on a block is the **structural source of truth** for which blocks are rolled up. It is a list of block hashes.

```
Block {
    aggregates: Hash[]   // blocks this block replaces
    ...
}
```

When block E has `aggregates: [X, Y]`, it means:

- X and Y (and their subtrees) are included in E's total ordering
- E's output-space transformation composes X's and Y's transformations with E's own
- E conflicts with X and Y (and anything built on them), preventing re-aggregation
- X and Y's subtrees must be rooted above E's anchor (their anchor chains pass through E's anchor)

### Invariants

1. **Rooted at anchor**: every aggregate's anchor chain must pass through the aggregating block's anchor. Formally, for each `a` in `block.aggregates`, `block.anchor` must appear in `a`'s ancestor chain. This ensures `subtreeFrom(a, block.anchor)` terminates correctly.
2. **Non-overlapping**: aggregate subtrees must be pairwise disjoint. No block appears in two aggregates' subtrees.
3. **Non-conflicting claims**: aggregates' claim masks against the anchor must not overlap. If they do, the aggregates conflict and cannot be combined.
4. **Weight-ratio balance**: aggregates must satisfy the weight-ratio constraint (see [dag.md](dag.md)).

---

## Aggregation Contract Output (Cache)

Every non-genesis block carries an aggregation marker output -- an output whose verifier uses the well-known `AGGREGATION_CONTRACT` hash. For leaf blocks (no aggregates), this marker has empty data and zero value. For aggregation blocks, the marker's `data` field carries cached transformation data.

The **aggregation cache** stores the net effect of a block's subtree on its anchor's output space, so that parent aggregators can compose transformations without walking the full subtree.

### Cache Contents

```
AggregationCache {
    claimMask:             number[]     // sorted anchor output indices claimed by the subtree
    newOutputCount:        number       // surviving outputs added by the subtree
    aggregateOutputCounts: number[]     // per-aggregate new output counts
    chainWeights:          number[]     // weight vector from subtrees (excludes own declaredWeight)
    aggregateWeights:      number[]     // per-aggregate total declared weights
}
```

- **`claimMask`**: a sorted array of anchor output space indices. Index `i` is present if the subtree (including the block itself) claims anchor output `i`.
- **`newOutputCount`**: the total number of new, surviving outputs the subtree contributes. This is the count of outputs that appear in the block's output space but not in the anchor's output space. It includes the block's own surviving outputs plus all aggregated subtrees' surviving outputs.
- **`aggregateOutputCounts`**: per-aggregate breakdown of new output counts, in the same order as `aggregates`. Used for navigating claim indices through the subtree structure (see [output-space.md](output-space.md#claim-index-resolution)).
- **`chainWeights`** and **`aggregateWeights`**: weight attribution data, used by the consensus module.

### Leaf Blocks

Leaf blocks (no aggregates) have a trivial cache. Their marker output has empty data. The cache is implicitly:

```
claimMask:             computed from block.claimIndices (non-self-claims only)
newOutputCount:        block.outputs.length - selfClaimCount
aggregateOutputCounts: []
chainWeights:          []
aggregateWeights:      []
```

This is computed on demand from the block's own fields, not stored in the output data.

---

## Cache Composition

The cache enables efficient composition: an aggregation block computes its cache from its immediate children's caches, not from the full subtree.

### Composing Independent Subtrees

Given aggregates [X, Y] with caches relative to the same anchor A:

```
composed.claimMask             = X.claimMask | Y.claimMask
composed.newOutputCount        = X.newOutputCount + Y.newOutputCount
composed.aggregateOutputCounts = [X.newOutputCount, Y.newOutputCount]
```

The claim masks are unioned. If they overlap (`X.claimMask & Y.claimMask != 0`), the aggregates conflict and cannot be combined -- this is the same conflict detection the conflict module performs.

### Adding the Block's Own Effects

After composing the subtrees, the aggregating block E applies its own transformation:

1. E prepends its own outputs to the post-subtree space
2. E applies its own claims from this extended vector
3. E's cache becomes:

```
E.claimMask             = composed.claimMask | E's own claims against anchor
E.newOutputCount        = composed.newOutputCount + E.outputs.length - E.selfClaimCount
E.aggregateOutputCounts = [X.newOutputCount, Y.newOutputCount]
```

Self-claims (index < `E.outputs.length`) do not contribute to the claim mask or output count.

### Different-Anchor Aggregates

Aggregates may anchor to different blocks in the anchor chain (e.g., X anchors to A directly, while Y anchors to B which is between A and Y). This is the linear aggregation case: `subtreeFrom(Y, A)` follows Y's anchor chain back to A, yielding intermediate blocks.

To compose the claim mask against the aggregator's anchor A, the system walks each aggregate's subtree ordering (`subtreeFrom(agg, A)`), resolves every non-self claim using `resolveClaimIndex`, and checks which resolved outputs belong to A's output space. This correctly handles arbitrary depth without explicit rebasing. See [output-space.md](output-space.md#claim-index-resolution) for the resolution algorithm.

---

## Aggregation Contract

The aggregation contract is a well-known contract registered under `AGGREGATION_CONTRACT` (= `Hash.digest('aggregation-contract')`). It runs in two modes:

### Generation Mode

The aggregation contract generator consumes aggregation marker outputs from blocks that should be aggregated. It calls `requireInput()` exactly `AGGREGATION_THRESHOLD` times. Each call:

1. Finds an unclaimed aggregation marker output in the UTXO index
2. If no input is available, **blocks** until one becomes available (see [Aggregation Trigger](#aggregation-trigger))
3. Adds the producing block as an implicit **include constraint** on the draft
4. Reads the marker's `data` to get the producing block's subtree cache (empty for leaves)

After consuming all inputs, the contract:

5. Composes the consumed caches into a new aggregation cache (see [Cache Composition](#cache-composition))
6. Produces an aggregation data output with the composed cache in `detail` via `requireOutput()`

### Verification Mode

The verification-mode contract checks that the aggregation cache is correctly computed from the aggregated blocks' caches. It:

1. Reads each aggregated block's aggregation cache (from refs or claimed inputs)
2. Composes them using the composition rules above
3. Verifies the block's aggregation output matches the expected composed result

### Relationship to `aggregates`

The aggregation contract does **not** set the `aggregates` field. The contract operates through the claim/output mechanism:

- The contract **claims** aggregation markers (consuming them)
- The contract **produces** a new aggregation data output (the composed cache)
- The `aggregates` field is set at **solidification** (when the draft becomes a real block), by the anchoring module, based on the include constraints accumulated during generation

The contract's include constraints and the `aggregates` field express the same information through different mechanisms. The contract accumulates constraints during generation; the `aggregates` field encodes the result in the block structure. They must agree: every block whose marker was claimed must appear in the aggregates (or their subtrees).

---

## Aggregation Trigger

Aggregation uses the same trigger mechanism as any other contract: a single unclaimed output triggers a draft + generation. There is no special aggregation strategy.

### Flow

1. A block is published with an aggregation marker output (every non-genesis block has one).
2. The DraftStrategy sees the unclaimed marker output and creates a draft with that marker as the trigger claim.
3. The ContractGenerator starts the aggregation contract via GeneratingEnv.
4. The contract calls `requireInput()` -- consumes the trigger marker.
5. The contract calls `requireInput()` again. If no more markers are available, the call **blocks** (returns a pending Promise). The draft stays in the `generating` state.
6. When the next block with an aggregation marker becomes canonical:
   - The system first checks for any generators blocked on the `AGGREGATION_CONTRACT` verifier.
   - If a blocked generator exists, it is **resumed**: the new marker is fed to the blocked `requireInput()`, which resolves.
   - If no blocked generator exists, DraftStrategy creates a new draft (step 2).
7. Steps 5-6 repeat until the contract has consumed `AGGREGATION_THRESHOLD` inputs.
8. The contract composes caches and produces the aggregation data output via `requireOutput()`.
9. The draft transitions to `ready`, then solidifies with computed anchor and aggregates.

### Blocking `requireInput()`

`requireInput()` has two behaviors depending on input availability:

- **Inputs available**: immediately consumes one and returns it (sync or resolved Promise).
- **No inputs available**: returns a pending Promise. The contract `await`s it. The generation is suspended until the system provides a new input.

The ContractGenerator maintains a registry of blocked generators, keyed by the verifier they are waiting on. When a new canonical output appears:

1. Check the blocked-generator registry for a matching verifier.
2. If a match exists: claim the output for the blocked generator, resolve its pending Promise. The contract execution resumes.
3. If no match: the output is available for DraftStrategy to trigger a new draft.

This priority order -- resume before trigger -- prevents duplicate drafts for the same contract and ensures inputs flow to existing in-progress generations before spawning new ones.

### Why No Special Aggregation Strategy

The aggregation contract is triggered by DraftStrategy, the same mechanism that triggers any contract. The only difference is that the aggregation contract requires multiple inputs, so it blocks between the first and last. This blocking/resume mechanism is general-purpose -- any contract that needs multiple inputs from the same verifier can use it. The aggregation contract is just the first consumer.

---

## Generation Constraints

During generation, the aggregation contract accumulates constraints that must be satisfied at solidification:

- **Include constraints**: blocks whose markers were consumed must be reachable from the final block's subtree. Each `requireInput()` implicitly adds the producing block as an include constraint.
- **Exclude constraints** (future): blocks that must NOT be in the subtree. Used by collateral contracts to ensure independence from the target block.

At solidification, the anchoring module computes:
1. **Anchor**: the shallowest block such that all include-constrained blocks' subtrees lie above it
2. **Aggregates**: the set of blocks whose subtrees, combined with the anchor's chain, cover all include-constrained blocks

Anchor and aggregates are determined simultaneously. See [draft-blocks.md](draft-blocks.md#anchor-derivation-at-publication).

---

## Module Boundary

### This Concern Receives

| Input | Source | Description |
|-------|--------|-------------|
| Aggregation marker outputs | UTXO index | Unclaimed markers from blocks eligible for aggregation |
| Subtree caches | Block outputs | Aggregation data from previously aggregated blocks |
| Canonicality changes | Consensus module | Triggers re-evaluation of aggregation opportunities |

### This Concern Provides

| Output | Consumer | Description |
|--------|----------|-------------|
| Aggregation cache | Conflict, consensus, output-claims modules | Composed transformation data (claim mask, output counts, weights) |
| Include constraints | Anchoring module | Which blocks must appear in the final subtree |
| Aggregation blocks | Block store, gossip | New blocks that consolidate subtrees |

### Invariants

1. **Cache correctness**: the aggregation cache is the composition of its children's caches plus the block's own effects. This is verifiable (and disputable) through the aggregation contract.
2. **Include coverage**: every block whose aggregation marker was claimed by the contract appears in the `aggregates` subtree.
3. **Claim mask conservation**: `cache.claimMask` is the union of all subtree claims and the block's own non-self claims against the anchor.
4. **Output count conservation**: `cache.newOutputCount` equals the total surviving outputs from the subtree (own outputs minus self-claims, plus all aggregates' new output counts).

---

## Implementation

| File | Description |
|------|-------------|
| [`src/contracts/AggregationContract.ts`](../../src/contracts/AggregationContract.ts) | Aggregation contract, `AggregationData`, `makeAggregationOutput()`, cache encode/decode, threshold constant |
| [`src/core/OutputSpace.ts`](../../src/core/OutputSpace.ts) | Claim resolution, claim masks, UTXO computation, total ordering |
| [`src/core/Block.ts`](../../src/core/Block.ts) | `AGGREGATION_CONTRACT` hash, `getBlockClaimMask()`, `getBlockWeightVector()` |
| [`src/core/ContractGenerator.ts`](../../src/core/ContractGenerator.ts) | Runs contracts via GeneratingEnv to build drafts |
| [`src/node/strategies/DraftStrategy.ts`](../../src/node/strategies/DraftStrategy.ts) | Triggers drafts for unclaimed outputs (including aggregation markers) |
