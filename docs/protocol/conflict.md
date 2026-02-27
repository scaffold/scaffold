# Conflict Module

The conflict module determines whether two blocks are **conflicting** — meaning they cannot both be included in the canonical view. It provides direct conflict declarations to the consensus module, which uses them for branch selection.

The core conflict condition is **double-spend**: two blocks that both claim (spend) the same output from a shared ancestor. The module encodes claims as bit vectors over the anchor's output set, enabling fast conflict detection via bitwise intersection.

This module is responsible for:
- Defining the output model (how blocks transform output sets)
- Encoding and comparing claim masks
- Detecting conflicts between same-anchor trees (direct comparison) and different-anchor trees (via rebasing)
- Managing partial knowledge of claim masks and monotonic conflict discovery

This module is **not** responsible for:
- Deciding which conflicting block wins (that's the consensus module)
- Verifying that claimed work is real (verification module)
- Defining what outputs represent semantically (application layer)

---

## Output Model

Every block (except genesis) anchors to a parent block. A block transforms its anchor's output vector in two phases:

### Phase 1 — Subtree Effects

Only applies if the block aggregates subtrees. Subtrees are applied sequentially in the order they appear in the block's children list. Each subtree removes its claims from the current output vector, then prepends its new outputs. Later subtrees can claim outputs produced by earlier ones.

- **`claimMask`**: Bit vector of length N (anchor's output count). Records which anchor outputs the subtrees collectively claim.
- **`aggregateOutputCounts`**: Vector of integers, one per subtree. Records how many outputs each subtree contributes.

### Phase 2 — Block's Own Effects

The block itself claims from the current output vector (which now includes subtree outputs and surviving anchor outputs), then prepends its own new outputs.

```
start:       [anchor outputs: o_0 .. o_{N-1}]
subtree 1:   remove s1.claims, prepend s1.outputs
subtree 2:   remove s2.claims, prepend s2.outputs
...
subtree K:   remove sK.claims, prepend sK.outputs
self:        remove own claims, prepend own outputs
end:         block's output vector
```

The output vector is ordered newest-first. Recent outputs cluster at the front, improving claim mask compression since recent outputs are claimed more frequently.

`claimMask` and `aggregateOutputCounts` exist purely for navigating the merkle tree — they let a peer locate which subtree produced or claimed a given output without loading the entire tree. The block's own claims and outputs are separate fields, not included in these.

### Block Header Fields (Conflict-Relevant)

| Field | Type | Description |
|-------|------|-------------|
| `claimMask` | Bit vector (length N) | Which anchor outputs the subtrees collectively claim |
| `aggregateOutputCounts` | Integer vector | Number of outputs each subtree contributes |
| `claims` | Block's own claims | Outputs this block itself spends from the current vector |
| `outputs` | Block's own outputs | New outputs this block itself produces |
| `outputCount` | Integer | Total output count after full transformation |

### Aggregation Example

Block A anchors to block X (which has 10 outputs). A aggregates subtrees S1 and S2 in that order:

1. **S1** claims outputs {2, 5} from X, produces 3 new outputs.
   Vector: `[s1_0, s1_1, s1_2, x_0, x_1, x_3, x_4, x_6, x_7, x_8, x_9]` (11 entries)

2. **S2** claims output {0} (which is `s1_0`, one of S1's outputs), produces 1 new output.
   Vector: `[s2_0, s1_1, s1_2, x_0, x_1, x_3, x_4, x_6, x_7, x_8, x_9]` (11 entries)

3. **A itself** claims output {3} (which is `x_0`), produces 2 new outputs.
   Vector: `[a_0, a_1, s2_0, s1_1, s1_2, x_1, x_3, x_4, x_6, x_7, x_8, x_9]` (12 entries)

A's conflict-relevant header: `claimMask = 0b0000100100` (bits 2 and 5), `aggregateOutputCounts = [3, 1]`.

---

## Conflict Detection

Two trees conflict if they attempt to spend the same output. Detection depends on whether the trees share an anchor.

### Same-Anchor Case

Two trees T1 and T2 with the same anchor conflict iff their claim masks intersect:

```
conflicts(T1, T2) = (T1.claimMask & T2.claimMask) != 0
```

This is a bitwise AND — one CPU instruction per word of the bit vector.

### Different-Anchor Case (Rebasing)

If T1 anchors to block P and T2 anchors to block Q, where Q is a descendant of P (Q's anchor chain passes through P), we must **rebase** T1's claims forward through the chain P → ... → Q.

Each block in the chain transforms the output vector: removing claimed outputs and prepending new ones. Rebasing maps T1's claim indices through these transformations:

1. For each block B in the chain from P toward Q:
   - If B claims an output that T1 also claims, **conflict** — both are spending the same output.
   - Otherwise, adjust T1's claim indices: remove indices that B claimed (they no longer exist), shift remaining indices to account for B's prepended outputs.
2. After reaching Q's output space, compare the rebased claims against T2's claim mask with bitwise AND.

Rebasing is always **forward** (toward descendants). When aggregating subtrees with different anchors, the aggregator's anchor must be a descendant of all subtrees' anchors, so all subtrees rebase toward the aggregator.

Rebasing can also detect conflicts with the chain itself — if T1 claims an output that an intermediate block already spent, that's a conflict discovered during rebasing.

---

## Partial Knowledge and Monotonic Discovery

A tree root's claim mask can be large. When a block is first received, its claim mask may only be **partially known**. The claim mask is split into chunks for merkle tree purposes — some chunks may be loaded and others missing.

### Default Assumption

Unknown chunks are treated as **unclaimed** (all zeros). This is optimistic: we do not generate conflicts from missing data. Conflicts can only be declared when we have positive evidence.

### Upward Inference

If we know that a block deep within a tree claims a specific output, we can infer that every aggregator above it in the tree must also claim that output — because the aggregator's claim mask represents the net effect of its subtrees. This lets us fill in bits of a partially-known claim mask without loading the full tree.

Concretely: if block B is a subtree of aggregator A, and B's claim mask has bit `i` set, then A's claim mask must also have bit `i` set (after index adjustment through any intermediate transformations).

### Monotonicity

Conflict discovery is monotonic:

- Once a bit is known to be claimed, it stays claimed — claim masks only grow.
- New conflicts can **appear** as more of the claim mask is revealed.
- Conflicts can **never disappear** — a confirmed double-spend is permanent.

This means a peer's conflict set grows over time as it downloads more of the block graph. Two peers may temporarily disagree about conflicts (one has loaded more chunks than the other), but they will converge as both fill in the same data.

### Verification Priority Implication

Peers should prioritize loading claim mask chunks where potential conflicts are most consequential — near the decision boundary of active consensus races.

---

## Module Boundary

### This Module Receives

| Input | Source | Description |
|-------|--------|-------------|
| Block claim mask | Block creation module | Bit vector of claimed outputs against anchor |
| Block output count | Block creation module | Number of new outputs the block produces |
| Aggregate output counts | Block creation module | Per-subtree output counts for aggregation blocks |
| Subtree ordering | Block creation module | Ordered list of subtrees for sequential transformation |
| Claim mask chunks | Network/sync module | Incrementally loaded chunks of partially-known claim masks |

### This Module Provides

| Output | Consumer | Description |
|--------|----------|-------------|
| Direct conflict declarations | Consensus module | "Block X conflicts with block Y" (double-spend detected) |
| Conflict set updates | Consensus module | New conflicts discovered as claim masks fill in |
| Rebase results | Block creation module | Rebased claim masks for aggregation across different anchors |

### Invariants

1. **Symmetry**: If A conflicts with B, then B conflicts with A.
2. **Monotonicity**: Once a conflict is declared, it is never retracted.
3. **Completeness**: With full knowledge of all claim masks, all double-spend conflicts are detected.
4. **Optimistic partial knowledge**: Missing data never produces false conflicts.
5. **Upward inference**: A known claim in a subtree implies the corresponding claim in all ancestor aggregators.
