# DAG Structure

The block graph is a **chain of trees**. This document describes the global topology: how blocks, anchors, and aggregation combine to form the DAG, how trees are kept balanced, and how the genesis block anchors everything.

For how individual blocks are constructed, see [block-creation.md](block-creation.md). For how conflicts between blocks are resolved, see [consensus.md](consensus.md).

---

## Chain of Trees

Every block has an **anchor** — a hash reference to an existing block. Genesis anchors to the **zero hash** (a reserved value that no real block can have), so every block uniformly has an `anchor: Hash` with no null case. The anchor determines the block's position in the graph and which outputs are available to claim. Multiple blocks can share the same anchor, forming parallel work at the same level.

**Aggregation** rolls up multiple subtrees into a single block. The subtrees within a tree anchor to the tree root's anchor or an ancestor of it — they are not required to share the same anchor. During aggregation, each subtree's UTXO claims are **rebased** forward to the aggregator's anchor (see [conflict module](conflict.md) rebasing). The subtree blocks themselves are not modified; rebasing maps their claims into the aggregator's output space so they can be merged. When a tree at one level is fully aggregated into a single root, new blocks can anchor to that root, forming the next tree.

This produces a **chain of trees**:

```
         ┌─────────────────────────────────────────┐
         │              Tree 1                      │
         │                                          │
         │           b6 (root)                      │
         │          ╱        ╲                      │
         │        b2          b5                    │
         │       ╱  ╲        ╱  ╲                   │
         │     b0    b1    b3    b4                 │
         │                                          │
         └──────────────┬──────────────────────────┘
                        │ anchor
                    [genesis]
```

In this simple example, all blocks in Tree 1 (b0 through b6) have `anchor: genesis`. In general, leaves and intermediate aggregators may anchor to the root's anchor or any ancestor of it — their claims are rebased forward during aggregation. The `╱╲` edges represent aggregation: b2 aggregates {b0, b1}, b5 aggregates {b3, b4}, b6 aggregates {b2, b5}.

Once b6 exists, new blocks can anchor to it:

```
    ┌──────────────────┐      ┌──────────────────┐
    │     Tree 2       │      │     Tree 4       │
    │                  │      │                  │
    │   b9 (root)      │      │   b12 (root)     │
    │   ╱        ╲     │      │      ╲           │
    │  b7        b8    │      │      b11         │
    │                  │      │                  │
    └────────┬─────────┘      └────────┬─────────┘
             │ anchor                  │ anchor
             └──────────┐  ┌───────────┘
                        │  │
         ┌──────────────┴──┴───────────────────────┐
         │              Tree 1                      │
         │           b6 (root)                      │
         │          ╱        ╲                      │
         │        b2          b5                    │
         │       ╱  ╲        ╱  ╲                   │
         │     b0    b1    b3    b4                 │
         └──────────────┬──────────────────────────┘
                        │ anchor
                    [genesis]
```

b7, b8, b9 all have `anchor: b6`. b11, b12 also have `anchor: b6`. Trees 2 and 4 are independent — their blocks can be aggregated together (assuming no conflicts) into a single block that also anchors to b6.

A single-block tree is also valid. b10 anchors to b9, forming Tree 3 — a single leaf that will eventually be aggregated with other work at the b9 level.

### The Anchor Chain

Following anchor links backward from any block produces its **anchor chain**:

```
b10 → b9 → b6 → genesis
```

The anchor chain with the most accumulated weight is the **canonical chain**. Since aggregation blocks consolidate the weight of their subtrees, the canonical chain naturally passes through the aggregation roots at each level. The canonical chain is the spine of the DAG; the trees hang off each link.

### How the Chain Extends

1. Leaf blocks are created, anchoring to the current chain tip or an ancestor of it.
2. Aggregators roll up leaves (and smaller aggregations) into progressively larger blocks.
3. Eventually a single root aggregation captures all the work at that level.
4. New leaf blocks anchor to the root, starting the next level.

In practice, the chain extends continuously — new leaves appear at the tip while aggregation of older levels is still in progress. Multiple levels of the chain may be actively growing at the same time.

---

## Balancing

For the DAG to support efficient operations (proofs, sampling descent, verification), the aggregation trees at each level must be roughly balanced. An unbalanced tree — say, a linear chain of aggregations — would have O(N) depth instead of O(log N).

### Weight-Ratio Constraint

Aggregation is restricted to subtrees with similar weights:

```
can_aggregate(S1, S2) iff max(weight(S1), weight(S2)) / min(weight(S1), weight(S2)) <= K
```

Where K is a protocol parameter (e.g., 2). An aggregator combining a 1000-weight subtree with a 1-weight subtree violates the constraint. Instead, small subtrees must first be aggregated with other small subtrees until they reach a weight comparable to the larger one.

This produces trees where sibling subtrees have weights within a factor of K, giving:

- **O(log N) tree depth** — where N is the number of leaves (or total weight / minimum leaf weight)
- **O(log N) merkle proofs** — proving any output's inclusion requires a path proportional to tree depth
- **O(log N) sampling descent** — weight-proportional random descent to select a unit of work for verification
- **Balanced risk** — an aggregator taking on two similarly-weighted subtrees has balanced fraud exposure on both sides

### Aggregation Ordering

Within a tree, aggregation proceeds bottom-up: leaves are aggregated first into small subtrees, then small subtrees into medium ones, and so on. At each step, the weight-ratio constraint determines which subtrees can be combined. The result is a structure resembling a balanced binary tree (or K-ary tree if more than two subtrees are aggregated at once).

The constraint is enforced by structural verification — an aggregation block whose children violate the weight ratio is structurally invalid.

---

## Genesis

The **genesis block** is the foundation of the entire DAG. It anchors to the **zero hash** and is the permanent root of every anchor chain.

### Properties

- **Concrete and serializable**: Genesis is a real block with a deterministic hash, not an implicit concept.
- **Very high declared weight**: Genesis has a `declaredWeight` larger than any tree will ever accumulate. This reflects its role as the immovable foundation — it is the most stable block in the system by definition.
- **Anchors to the zero hash**: `anchor: 0x0000...`. The zero hash is a reserved value — no real block can have it as its hash. This keeps the `anchor` field uniformly typed as `Hash` with no null/optional case.
- **Empty weight vector**: Since the weight vector is indexed by anchor chain depth and genesis's anchor (the zero hash) does not correspond to a real block, its weight vector is empty. The high `declaredWeight` exists as a field but is not attributed to any chain level.
- **Network identifier**: The genesis hash uniquely identifies a network. Two nodes are on the same network if and only if they share the same genesis hash.

### Un-Aggregatable

Genesis cannot be aggregated. Two mechanisms prevent it:

1. **Weight-ratio constraint**: Genesis's declared weight is far larger than any tree's weight, so `can_aggregate(genesis, tree)` always fails the balance check.
2. **No valid anchor**: An aggregator of genesis would need an anchor that is a descendant of genesis's anchor (the zero hash). No such block exists.

Genesis is not a member of any tree. It is the anchor that the first tree hangs from, and by extension, the root of the entire chain.

---

## Initial Outputs and Fixed Supply

The total supply of coins in the network is **fixed at genesis**. The genesis block outputs the entire supply to a **distribution contract** — a contract that governs how coins enter circulation.

```
Genesis outputs:
  Output {
    contract:  DISTRIBUTION_CONTRACT_HASH
    value:     TOTAL_SUPPLY
    data:      <distribution parameters>
  }
```

The distribution contract defines the rules for claiming coins: who can claim, how much, how often, and under what conditions. The protocol does not prescribe a specific distribution mechanism — it is determined by the contract code embedded in genesis.

All subsequent blocks obey **throughput balancing** (see [block-creation.md](block-creation.md)): `sum(input_values) == sum(output_values)`. No block creates or destroys value. Coins flow from the distribution contract into circulation through claims, and thereafter circulate through normal spending, fees, and collateral.

---

## Non-Canonical Blocks

The canonical DAG is a single chain of trees where each tree has one root aggregation. In practice, multiple competing blocks exist at every level.

### Competing Aggregations

Two aggregators may independently roll up the same children. Both blocks are valid, but they conflict — each aggregates the same blocks, so they cannot coexist in the canonical view. The [consensus module](consensus.md) resolves this by effective weight: the aggregation with more descendant weight wins.

### Overlapping Aggregations

Aggregator A rolls up {L1, L2, L3}. Aggregator B rolls up {L2, L3, L4}. These conflict because both aggregate L2 and L3. The canonical view includes one or the other, never both. The losing aggregator's work is excluded, but the individual leaves it aggregated may still be picked up by a future aggregation on the winning branch.

### Multiple Trees at the Same Anchor

Many blocks can anchor to the same block simultaneously. Most are compatible (no conflicting claims). Incompatible blocks — those that claim the same outputs — enter a conflict that consensus resolves. Aggregation can combine any subset of non-conflicting blocks at the same anchor level.

---

## Interaction with Other Modules

**Block creation**: Constructs blocks with correct anchors, aggregation structure, and weight vectors. Enforces the weight-ratio constraint during aggregation. See [block-creation.md](block-creation.md).

**Consensus**: Resolves conflicts between competing blocks and aggregations. The canonical chain is the path through the DAG with the most verified descendant weight. See [consensus.md](consensus.md).

**Conflict**: Detects double-spends via claim mask intersection. Rebases claim masks when comparing blocks at different anchor levels. See [conflict.md](conflict.md).

**Sampling**: Descends aggregation trees to select units of work for verification. Balanced trees ensure this descent is O(log N). See [sampling.md](sampling.md).

**Trust**: Collateral is placed on blocks within trees. Aggregators take on the fraud risk of their subtrees. The tree structure determines the scope of collateral claims. See [trust.md](trust.md).

---

## Implementation

DAG topology is an emergent property of the block and consensus structures rather than a standalone module.

| File | Description |
|------|-------------|
| [`src/core/Block.ts`](../../src/core/Block.ts) | Block data structure (anchor, aggregates), `BlockStore`, genesis creation |
| [`src/core/ConsensusModule.ts`](../../src/core/ConsensusModule.ts) | Anchor chain traversal, descendant weight accumulation |
| [`src/core/Coordinator.ts`](../../src/core/Coordinator.ts) | Orchestrates all modules; processes blocks through the full pipeline |
