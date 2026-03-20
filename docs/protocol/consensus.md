# Consensus Module

The consensus module chooses between conflicting branches in the block graph. Its goal is **eventual agreement**: all peers converge on the same branch for each conflict. The mechanism is **verified descendant weight** — the branch with the most proven work wins.

Consensus is always soft. There is no finality. A winning branch can always be overtaken by sufficient conflicting weight. Earlier blocks are naturally more stable because they've had more time to accumulate descendant weight.

---

## Block Model

At this module, a block is:

```
Block {
    anchor:      Hash         // the chain block this builds on (genesis uses the zero hash)
    weight:      Number[]     // weight vector indexed by anchor chain depth
    aggregates:  Set<Hash>    // blocks this block replaces (dependency, not conflict)
}
```

Everything else (internal tree structure, execution details, how work is verified) belongs to other modules.

### Anchor Chain

A block's **anchor chain** is the sequence of blocks reached by repeatedly following `anchor` links:

```
B → B.anchor → B.anchor.anchor → ... → genesis
```

This forms a path from the block back to genesis. The chain may be shared among many blocks (multiple blocks can anchor to the same block, forming a DAG).

### Weight Vector

A block's **weight vector** is an array of non-negative numbers, indexed by anchor chain depth:

- `weight[0]` = work this block contributes as a descendant of its direct anchor
- `weight[1]` = work this block contributes as a descendant of its anchor's anchor
- `weight[2]` = work this block contributes as a descendant of two levels up
- ... and so on back to genesis

The weight vector allows a single block to correctly attribute work to multiple levels of the chain. For example, a block that aggregates work referencing different chain levels declares exactly how much weight applies to each level.

A simple leaf block typically has `weight = [w, 0, 0, ...]` — all its work derives from its direct anchor's state.

The total declared weight of a block is `sum(weight)`.

### Aggregates

A block's **aggregates** set contains the hashes of blocks it replaces. When block C aggregates blocks A1 and A2, it means "C is a rolled-up replacement for A1 and A2."

Aggregation creates a **dependency**, not a conflict. C depends on the correctness of A1 and A2. If any aggregated block becomes non-canonical (e.g., it loses a conflict), C becomes non-canonical too -- not because C conflicts with anything, but because its dependency is no longer valid. See [Canonicality Rules](#canonicality-rules) below.

### Genesis

The **genesis block** anchors to the **zero hash** (`anchor: 0x0000...`), has an empty weight vector, and an empty aggregates set. It has a very high `declaredWeight` — larger than any tree will ever accumulate — reflecting its role as the permanent, immovable root of the DAG. The zero hash is a reserved value that no real block can have, keeping the `anchor` field uniformly typed as `Hash`. Its weight vector is empty because the zero hash does not correspond to a real block. Genesis has no conflicts. All other blocks eventually anchor back to genesis.

See [DAG Structure](dag.md) for the full description of genesis and the chain-of-trees topology.

### Ancestors and Descendants

- **`ancestors(X)`** = all blocks reachable from X by following `anchor` links (backward in time).
- **`descendants(X)`** = all blocks that have X in their anchor chain (forward in time). Equivalently, blocks reachable from X by following inverse anchor links.

### Graph Topology

Multiple blocks can anchor to the same block, creating a DAG:

```
         [genesis]
            |  anchor
           [C1]
          /    \  anchor
       [C2a]  [C2b]
       / \      |   anchor
    [C3] [C3']  [C3'']
```

C2a and C2b both anchor to C1. They may or may not conflict. Non-conflicting blocks at the same level can be aggregated by a single block, consolidating their weight.

---

## Conflicts

### Sources

Conflicts come from one source: the [output claims module](output-claims.md). When two blocks' claims migrate to the same output, those two blocks are in **direct conflict** -- they are attempting to spend the same resource.

### Properties

- **Symmetric**: If A conflicts with B, then B conflicts with A.
- **Discoverable**: New conflicts can appear at any time as claim masks are loaded and claims migrate.
- **Direct only**: Conflicts are between the two claimant blocks. There is no conflict inheritance or forward propagation. The effects of a conflict on ancestors and descendants are handled by the canonicality rules, not by expanding the conflict set.

### No Propagation

Conflicts do **not** propagate through the anchor chain. If X conflicts with Y, blocks built on top of Y are not "in conflict with" X. Instead, if Y loses the conflict and becomes non-canonical, its descendants become non-canonical because their anchor is non-canonical -- a structural dependency, not a conflict.

```
    [X]        [Y] ← anchor ← [Z]
     X ⚡ Y  →  Z is non-canonical (because Y is non-canonical)
               but Z does NOT conflict with X
```

Similarly, aggregation does not create conflicts. If C aggregates A, and A conflicts with B, then C does not conflict with B. Instead, if A loses to B and becomes non-canonical, C becomes non-canonical because it aggregates a non-canonical block.

```
    [C] aggregates [A]        [B]
         A ⚡ B  (direct conflict from output claims)
         If B wins: A is non-canonical → C is non-canonical (dependency)
         C does NOT conflict with B
```

### Conflict Re-evaluation

When a new conflict is discovered, the consensus module re-evaluates canonicality. A previously canonical block may become non-canonical if a new conflict causes one of its dependencies (anchor or aggregates) to lose.

---

## Weight

### Descendant Weight

The **descendant weight** of a chain block C is the total verified work attributed to C by all blocks that have C in their anchor chain:

```
descendant_weight(C) = sum of B.verified_weight[i]
    for each block B
    where B's anchor chain at depth i equals C
```

Descendant weight includes **all** descendants, regardless of their canonicality. This is what makes effective weight canonical-independent (see below).

### Effective Weight (for conflict resolution)

When two blocks B1 and B2 conflict, we compare their **effective weight**:

```
effective_weight(B) = sum(B.verified_weight) + descendant_weight(B)
```

Where:
- `sum(B.verified_weight)` is B's own total verified work (across all chain levels)
- `descendant_weight(B)` is the total verified work of all blocks that anchor to B (directly or transitively)

Effective weight is **canonical-independent**: it includes all descendants, regardless of whether those descendants win their own conflicts. This ensures stable weight computation -- a block's effective weight does not change based on which iteration of conflict resolution we are in.

Descendant weight is recursive:

```
descendant_weight(B) = sum of effective_weight(D)
    for each D that directly anchors to B
```

### Verified vs. Declared Weight

A block declares a weight vector. The **verification module** (specified separately) produces a verified weight vector by sampling and spot-checking the declared work. This module uses verified weights for all computations.

- **Conservative default**: Unverified weight is zero. A block contributes nothing until its work is verified.
- **Incremental**: As verification progresses, verified weights converge toward declared weights (or toward zero for fraudulent blocks).

---

## Verification (Interface)

This module does not specify how verification works internally (that belongs to the verification module). It specifies the interface:

1. **Input**: A block with a declared weight vector.
2. **Output**: A verified weight vector (component-by-component, each ≤ the declared value).
3. **Properties**:
   - **Statistical convergence**: Peers verify independently and converge on similar verified weights.
   - **Continuous**: Verification is ongoing. New blocks are continuously verified.
   - **Conservative default**: Unverified = zero weight.
   - **Self-correcting**: If a verified weight changes (e.g., fraud detected), conflict resolutions update accordingly.

### Verification Priority

A peer cannot verify everything — it must prioritize. The recommended heuristic: **prioritize verification where the potential weight swing is largest**. Focus on blocks near the decision boundary of active conflicts, where verification could flip the outcome.

---

## Canonicality

### Canonicality Rules

A block is **canonical** if and only if all three conditions hold:

1. **Anchor rule**: Its anchor is canonical (or it is genesis).
2. **Aggregation rule**: All blocks it aggregates are canonical.
3. **Conflict rule**: It wins all its direct conflicts (by effective weight; ties broken by block hash, lexicographic ordering).

A block that fails any rule is **non-canonical**. The canonical view is the set of all canonical blocks.

These three rules replace the previous system of conflict propagation and conflict inheritance. Descendants of a losing block are not "in conflict" -- they are simply non-canonical because their anchor (rule 1) or an aggregated block (rule 2) is non-canonical. This is a structural dependency, not a conflict relationship.

### Conflict Resolution

For each pair of directly conflicting blocks A and B:

1. Compute `effective_weight` for each.
2. The block with higher `effective_weight` wins.
3. Ties are broken deterministically by block hash (lexicographic ordering).
4. The winner can change at any time as weights update, new blocks arrive, or new conflicts are discovered.

Effective weight is **canonical-independent** (see [Weight](#weight) below), so conflict winners can be determined without first knowing canonicality. This makes the computation non-circular.

### Canonicality Algorithm

Canonicality is computed in topological order using Kahn's algorithm over the dependency graph (anchor + aggregate edges).

**Phase 1 -- Determine conflict winners:**

For each block that has direct conflicts, compare effective weights. This can be done independently for each conflict pair because effective weight does not depend on canonicality.

**Phase 2 -- Topological canonicality sweep:**

1. Build the dependency graph: each block depends on its anchor and all blocks it aggregates. Compute in-degrees.
2. Initialize the queue with all zero-in-degree blocks (genesis).
3. For each block dequeued:
   - Check **anchor rule**: Is its anchor canonical? (Genesis passes trivially.)
   - Check **aggregation rule**: Are all its aggregated blocks canonical?
   - Check **conflict rule**: Did it win all its direct conflicts (from Phase 1)?
   - If all pass, mark canonical. Otherwise, mark non-canonical.
   - Decrement in-degree for all blocks that depend on this block (blocks that anchor to it, and blocks that aggregate it). Enqueue any that reach zero.

This runs in O(|blocks| + |edges|) time. The topological order guarantees that when a block is processed, all its dependencies have already been resolved.

### Canonical View

A peer's **canonical view** is the set of all canonical blocks. It is each peer's best understanding of the "true" state of the network, continuously updated as new blocks arrive, weights change, or new conflicts are discovered.

### Why Earlier Blocks are More Stable

There is no explicit finality or time preference. However, earlier blocks are naturally more stable:

- They've had more time to accumulate descendant weight.
- To overtake an early block, an attacker must produce more verified weight than what has already been built on top of it -- which grows continuously.
- The cost of attack grows over time, making reversals increasingly impractical (though never impossible).

---

## Security Analysis

### Weight Inflation Attack

**Attack**: Create blocks with inflated weight vectors to win conflicts without doing real work.

**Defense**: The verification module spot-checks declared work. Fake work fails verification, the verified weight drops to zero, and the inflated branch loses.

### Conflict Spam Attack

**Attack**: Create many conflicting blocks to fragment the network's attention.

**Defense**: Conflicts are resolved by weight. Spam blocks with little real work lose immediately. Other modules can impose costs on block creation (e.g., collateral) to make spam economically infeasible.

### Sybil Attack

**Attack**: Create many identities to influence consensus.

**Defense**: Consensus is based on verified work, not identity count. More identities with the same total work gain nothing.

### Late Reversal Attack

**Attack**: Build a secret branch with real work, then reveal it to overtake a long-standing winner.

**Defense**: Economic — the attacker must produce more real work than the entire network has built on the current winner. This becomes prohibitively expensive over time.

### Work Laundering Attack

**Attack**: Aggregate a contested block to inherit its work without inheriting its conflicts.

**Defense**: The aggregation canonicality rule. If A is non-canonical (it lost a conflict), any block that aggregates A is also non-canonical -- not because it inherits the conflict, but because it depends on a non-canonical block. The aggregator cannot be canonical unless all its aggregated blocks are canonical.

### Sampling Manipulation

**Attack**: Selectively report verification results to bias others' views.

**Defense**: Peers verify independently. Each peer's canonical view is based on its own verification. Convergence happens because real work produces consistent results regardless of who verifies it.

---

## Concrete Example

### Setup

Genesis block `G` exists. Three blocks anchor to `G`:

- **Block A**: `weight = [100]`, anchors to G
- **Block B**: `weight = [80]`, anchors to G
- **Block C**: `weight = [50]`, anchors to G

A and B have a direct conflict (they both claim the same output, detected by the output claims module). C does not conflict with either.

### Initial State (Unverified)

All weights are unverified (zero effective weight). Tie broken by hash: say `hash(A) < hash(B)`, so A wins tentatively.

Canonicality (topological order: G first, then A/B/C):
- G: canonical (genesis).
- A: anchor G is canonical, no aggregates, wins conflict with B (tie-break). **Canonical.**
- B: anchor G is canonical, no aggregates, loses conflict with A. **Non-canonical.**
- C: anchor G is canonical, no aggregates, no conflicts. **Canonical.**

### After Verification

Verification of A finds 90% of work is real: `verified_weight(A) = [90]`.
Verification of B finds 100% real: `verified_weight(B) = [80]`.

A wins the conflict (90 > 80). Same canonicality result.

### New Blocks Arrive

Block D (`weight = [200]`) anchors to B.
Block E (`weight = [50]`) anchors to A.

Now descendant weight matters:

- `effective_weight(A) = 90 + effective_weight(E) = 90 + 50 = 140`
- `effective_weight(B) = 80 + effective_weight(D) = 80 + 200 = 280`

Note: effective weight includes **all** descendants regardless of their canonicality. D contributes to B's weight even though D's own canonicality depends on B's. This is what makes the computation non-circular.

**B overtakes A.** Now re-evaluate canonicality (topological order):
- G: canonical.
- A: anchor G canonical, no aggregates, loses conflict with B (140 < 280). **Non-canonical.**
- B: anchor G canonical, no aggregates, wins conflict with A. **Canonical.**
- E: anchor A is non-canonical. **Non-canonical** (anchor rule, not a conflict).
- D: anchor B is canonical, no conflicts. **Canonical.**
- C: anchor G canonical, no conflicts. **Canonical.**

E becomes non-canonical because its anchor A lost -- not because E is "in conflict with" anything. If A later reclaims the lead, E automatically becomes canonical again.

### Aggregation Example

Block S aggregates A and E: `aggregates = {A, E}`, `weight = [90, 50]`.

S does **not** conflict with B. But S depends on A and E being canonical (aggregation rule). Since A is non-canonical (it lost to B), S is also non-canonical:

Canonicality check for S:
- Anchor rule: S anchors to G, which is canonical. Pass.
- Aggregation rule: S aggregates A. A is non-canonical. **Fail.**
- S is **non-canonical**.

If A's branch later overtakes B's branch, A becomes canonical, and then S's aggregation rule would pass too.

### Fraud Detection

Continuing with B winning: further verification of D reveals 50% fake work.

- `verified_weight(D) = [100]`
- `effective_weight(B) = 80 + 100 = 180`

A's branch is at 140. B still wins, but the gap has narrowed. If more real work arrives on A's branch, A could reclaim the lead -- and all of A's descendants (E) and aggregators (S) would become canonical again.

---

## Module Boundary

### This Module Receives

| Input | Source | Description |
|-------|--------|-------------|
| Block anchor + weight vector | Block creation module | Where the block attaches and how much work it claims at each chain level |
| Aggregates set | Block creation module | Which blocks this block replaces (dependency for canonicality) |
| Direct conflict declarations | Output claims module | "Block X conflicts with block Y" (both claim the same output) |
| Verified weight vectors | Verification module | Component-by-component verified weights |

### This Module Provides

| Output | Consumer | Description |
|--------|----------|-------------|
| Canonical view | All modules | The set of blocks that pass all three canonicality rules |
| Conflict winners | All modules | For each direct conflict, which block currently wins |
| Effective weight estimates | Verification module | Current weights, to inform verification priority |
| Descendant weight per chain block | All modules | How much verified work has been built on each chain block |

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/ConsensusModule.ts`](../../src/core/ConsensusModule.ts) | Core algorithm: effective weight, conflict resolution, canonical view |
| [`src/core/ConsensusService.ts`](../../src/core/ConsensusService.ts) | Wired adapter using concrete `Block` type |
