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
    aggregates:  Set<Hash>    // blocks this block replaces (implies conflict + inheritance)
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

A block's **aggregates** set contains the hashes of blocks it replaces. This is the consensus module's representation of aggregation: when block C aggregates blocks A1 and A2, it means "C is a rolled-up replacement for A1 and A2."

Aggregation implies:
1. **Conflict**: C conflicts with every block in its aggregates set. They can never coexist in the canonical view.
2. **Conflict inheritance**: C inherits all conflicts from every block it aggregates, recursively. If A1 conflicts with B, and C aggregates A1, then C also conflicts with B.

Conflict inheritance is dynamic: if a new conflict involving A1 is discovered after C was created, C automatically inherits it.

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

Conflicts come from three sources:

1. **Direct conflicts**: Declared by other modules (e.g., "A and B both claim the same resource").
2. **Aggregation conflicts**: A block conflicts with every block it aggregates.
3. **Inherited conflicts**: A block inherits all conflicts from blocks it aggregates, recursively.

### Properties

- **Symmetric**: If A conflicts with B, then B conflicts with A.
- **Discoverable**: New direct conflicts can be reported at any time.
- **Dynamic inheritance**: Inherited conflicts update automatically when new direct conflicts are discovered.

### Propagation

**Rule**: If X conflicts with Y, and Y is an ancestor of Z (via anchor chain), then X conflicts with Z.

This means: everything built on top of a conflicting block is also in conflict.

```
    [X]        [Y] ← anchor ← [Z]
     X ⚡ Y  →  X ⚡ Z
```

This does **not** propagate backward: if X conflicts with Y, and Y anchors to W, then W is **not** in conflict with X. W existed before Y and is independent.

```
    [X]        [W] ← anchor ← [Y]
     X ⚡ Y  ↛  X ⚡ W
```

### Aggregation and Inheritance Example

```
    [C] aggregates [A]        [B]
         C ⚡ A  (from aggregation)
         A ⚡ B  (from another module)
         ∴ C ⚡ B  (inherited via aggregation)
```

Without inheritance, C could "launder" A's contested work by rolling it up. Inheritance prevents this: if A is bad, C (which claims A's work) is also considered bad.

### Conflict Re-evaluation

When a new conflict is discovered, the consensus module re-evaluates all affected branches. A previously winning branch may lose if its effective weight is now contested. Because inheritance is dynamic, a new conflict involving an aggregated block immediately affects the aggregating block too.

---

## Weight

### Descendant Weight

The **descendant weight** of a chain block C is the total verified work attributed to C by all non-conflicting blocks:

```
descendant_weight(C) = sum of B.verified_weight[i]
    for each non-conflicting block B
    where B's anchor chain at depth i equals C
```

In other words: every block that has C in its anchor chain contributes its weight at the corresponding depth. Only blocks in the canonical view (non-conflicting winners) are counted.

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

## Branch Selection

### Conflict Resolution

For each conflict set `{A, B, C, ...}`:

1. Compute `effective_weight` for each block.
2. The **winner** is the block with the highest `effective_weight`.
3. Ties are broken deterministically by block hash (lexicographic ordering).
4. The winner can change at any time as weights update, new blocks arrive, or new conflicts are discovered.

### Canonical View

A peer's **canonical view** is the maximal set of non-conflicting blocks where, for each conflict, the winner is included and losers are excluded. Blocks not involved in any conflict are always included.

The canonical view is each peer's best understanding of the "true" state of the network. It is continuously updated.

### Why Earlier Blocks are More Stable

There is no explicit finality or time preference. However, earlier blocks are naturally more stable:

- They've had more time to accumulate descendant weight.
- To overtake an early block, an attacker must produce more verified weight than what has already been built on top of it — which grows continuously.
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

**Defense**: Conflict inheritance. Aggregating a block means inheriting all its conflicts. If A is contested, any block that aggregates A is also contested.

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

A and B conflict (they both claim the same resource, per another module). C does not conflict with either.

### Initial State (Unverified)

All weights are unverified (zero effective weight). Tie broken by hash: say `hash(A) < hash(B)`, so A wins tentatively.

### After Verification

Verification of A finds 90% of work is real: `verified_weight(A) = [90]`.
Verification of B finds 100% real: `verified_weight(B) = [80]`.

A wins the conflict (90 > 80). C is uncontested and included in canonical view.

### New Blocks Arrive

Block D (`weight = [200]`) anchors to B.
Block E (`weight = [50]`) anchors to A.

Now descendant weight matters:

- `effective_weight(A) = 90 + effective_weight(E)`
- `effective_weight(B) = 80 + effective_weight(D)`

After verification: D's work is real (200), E's work is real (50).

- `effective_weight(A) = 90 + 50 = 140`
- `effective_weight(B) = 80 + 200 = 280`

**B overtakes A.** A and E are excluded from canonical view. D and everything built on D are included.

### Aggregation Example

Block S aggregates A and E: `aggregates = {A, E}`, `weight = [90, 50]` (90 attributed to G level via A's anchor, 50 attributed to G level via E being built on A).

S conflicts with A and E (aggregation). S also inherits A's conflict with B. So S conflicts with B.

S's effective weight = 90 + 50 = 140. B's effective weight = 280. B still wins. S and its aggregated blocks are excluded.

### Fraud Detection

Continuing with B winning: further verification of D reveals 50% fake work.

- `verified_weight(D) = [100]`
- `effective_weight(B) = 80 + 100 = 180`

A's branch is at 140. B still wins, but the gap has narrowed. If more real work arrives on A's branch, A could reclaim the lead.

---

## Module Boundary

### This Module Receives

| Input | Source | Description |
|-------|--------|-------------|
| Block anchor + weight vector | Block creation module | Where the block attaches and how much work it claims at each chain level |
| Aggregates set | Block creation module | Which blocks this block replaces |
| Direct conflict declarations | Validity/execution modules | "Block X conflicts with block Y" |
| Verified weight vectors | Verification module | Component-by-component verified weights |

### This Module Provides

| Output | Consumer | Description |
|--------|----------|-------------|
| Canonical view | All modules | The set of non-conflicting blocks that constitutes the current consensus |
| Conflict winners | All modules | For each conflict set, which block currently wins |
| Effective weight estimates | Verification module | Current weights, to inform verification priority |
| Descendant weight per chain block | All modules | How much verified work has been built on each chain block |

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/ConsensusModule.ts`](../../src/core/ConsensusModule.ts) | Core algorithm: effective weight, conflict resolution, canonical view |
| [`src/core/ConsensusService.ts`](../../src/core/ConsensusService.ts) | Wired adapter using concrete `Block` type |
