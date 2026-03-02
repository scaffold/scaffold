# Block Creation Module

The block creation module constructs blocks that are structurally valid and ready for distribution. It is the source of the inputs that every other module consumes: anchor placement, weight vectors, claim masks, output sets, and aggregation structure.

This module is responsible for:
- Defining the block structure (the canonical schema all modules reference)
- Constructing blocks from drafts: selecting anchors, computing claim masks, producing outputs, deriving weight vectors
- Managing drafts and their lifecycle as canonical state evolves
- Aggregation: rebasing subtrees, merging claim masks, attributing weight
- Throughput balancing (value conservation across inputs and outputs)

This module is **not** responsible for:
- Serialization/deserialization of blocks (handled by a separate module)
- Deciding which conflicting block wins (consensus module)
- Verifying that another block's computation is correct (verification module)
- Distributing blocks to peers (gossip module)
- Collateral placement (trust module — and collateral must be a separate block)

---

## Block Structure

A block is the fundamental unit of work. It represents a claim: "given these inputs, running this computation produces these outputs," anchored to a specific position in the block graph.

```
Block {
    // -- Structural --
    anchor:               Hash?           // parent in the anchor chain (none for genesis)
    aggregates:           Set<Hash>       // blocks this block replaces
    claimMask:            MerkleRoot      // all claims against anchor outputs (subtree + own)
    aggregateOutputCounts: Number[]       // per-subtree output counts
    ownOutputCount:       Number          // outputs this block itself produces
    claims:               Index[]         // indices into extended vector (own outputs + post-subtree)
    outputs:              Output[]        // new outputs this block produces
    outputCount:          Number          // total outputs after full transformation

    // -- Weight --
    declaredWeight:       Number          // work this block itself contributes
    weight:               Number[]        // weight vector, structurally derived (see Weight Vector)

    // -- Identity --
    creator:              PublicKey       // block creator
    signature:            Signature       // creator's signature over the block
}
```

Blocks are identified by their hash. Once created, a block is immutable.

---

## Outputs and Contracts

An **output** is a resource produced by a block:

```
Output {
    contract:   Hash      // spending condition (hash of contract WASM)
    value:      Number    // economic value
    data:       Bytes     // application-specific payload
}
```

A **contract** defines the spending condition for an output. It is identified by the hash of its WASM code. When a block claims an output, the contract WASM is executed on the block — it accepts or rejects the claim. This is **contractual verification**, distinct from structural verification.

Contracts are general-purpose. Example contract types:

| Contract | Condition | Use |
|----------|-----------|-----|
| Signature | Block is signed by key K | Balance, ownership |
| Computation | Block produces valid WASM execution result | Game state, request/response |
| Aggregation | Block aggregates the parent block | Aggregation incentive fees |
| Timelock | Block's anchor is past depth D | Delayed spending |

The protocol does not define a fixed set of contracts. Any valid WASM that accepts or rejects a block can serve as a contract. The spending condition is entirely determined by the contract code.

---

## Output Transformation

Every block transforms its anchor's output vector. The transformation has two phases, specified in detail by the [conflict module](conflict.md).

### Phase 1 — Subtree Effects

If the block aggregates subtrees, each subtree's claims and outputs are applied sequentially.

### Phase 2 — Block's Own Effects

The block prepends its own outputs, then applies its own claims:

```
self:  prepend own outputs, THEN remove own claims
```

Because outputs are prepended before claims, the block can **self-claim** — claim its own outputs. Self-claims (indices < `ownOutputCount`) produce and consume an output atomically. The output never enters the UTXO set. This enables a block to satisfy a contract in a single block: produce the required output, use it to satisfy the spending condition, and consume it — all in one step.

Self-claims are economically neutral (they net to zero in throughput) and do not participate in conflict detection.

For the full specification of output transformation, conflict detection, and rebasing, see [conflict module](conflict.md).

---

## Weight Vector

The weight vector attributes work to the correct levels of the anchor chain. It is **structurally derived** — deterministically computable from the block's `declaredWeight` and its subtrees' weight vectors.

### Leaf Block (no subtrees)

```
weight = [declaredWeight, 0, 0, ...]
```

All work is attributed to the direct anchor.

### Aggregation Block

Each subtree Si is anchored at some depth di relative to this block's anchor (di = 0 means same anchor, di = 1 means the subtree anchors to this block's anchor's anchor, etc.).

```
weight[d] = (d == 0 ? declaredWeight : 0)
           + sum(Si.weight[d - di] for each subtree Si where d >= di)
```

The aggregation block's own `declaredWeight` contributes at depth 0. Each subtree's weight vector is shifted by its anchor depth and added in.

### Verification

The structural verification module checks that `weight` is correctly derived from the block's `declaredWeight` and its subtrees. It does **not** verify that `declaredWeight` is honest — that is an open design question documented in [weight.md](weight.md).

---

## Throughput Balancing

Every block must conserve value:

```
sum(input_values) = sum(output_values)
```

Where input values are the values of claimed outputs (consumed) and output values are the values of new outputs (produced). Self-claimed outputs net to zero and do not affect the balance.

A block's inputs and outputs decompose into **functional** (the block's purpose) and **economic** (balance adjustment):

### Input Throughput > Output Throughput

The block produces more value than it consumes functionally. The surplus is the block creator's profit — output as a signature-contract output to the creator.

```
Functional inputs:   100 (computation request)
Functional outputs:   20 (result)
Economic outputs:     80 (fee to creator, signature contract)
```

### Output Throughput > Input Throughput

The block consumes more value than its functional inputs provide. The deficit must be funded from the creator's own balance outputs.

```
Functional inputs:     0
Functional outputs:   50 (new content state)
Economic inputs:      50 (from creator's balance, signature contract)
```

### Anchor Constraint

Economic inputs (creator's balance outputs) must exist in the UTXO set at the anchor point. This constrains anchor selection: the anchor must be deep enough that the creator's balance outputs are available. If those outputs become unavailable (because a branch the creator built on lost a consensus race), the block must be recreated from its draft with new economic inputs.

---

## Anchor Selection

The anchor determines the block's position in the graph and which outputs are available to claim. Selection criteria:

1. **Availability**: All required inputs (functional and economic) must exist in the UTXO set at the anchor.
2. **Depth**: Prefer the deepest anchor that satisfies (1). Deeper anchors are more stable — they have more descendant weight and are harder to overturn.
3. **Aggregation compatibility**: For aggregation blocks, the anchor must be a descendant of all subtrees' anchors (so all subtrees can be rebased forward).

---

## Aggregation

An aggregation block rolls up multiple subtrees into a single block. It replaces the aggregated blocks in the canonical view, consolidating their weight and compressing the graph.

### Design Principle: Minimal I/O

Aggregation blocks should have minimal inputs and outputs beyond what's structurally necessary. This keeps them small, which means faster gossip propagation and lower bandwidth cost. The aggregation block's purpose is structural consolidation, not application logic.

Typical aggregation block I/O:
- **Inputs**: Aggregation incentive outputs from the subtrees being aggregated (collecting fees).
- **Outputs**: An aggregation incentive output for further aggregation of this block, plus fee outputs to the aggregator.

### Construction

1. **Choose anchor**: Must be a descendant of all subtrees' anchors.
2. **Rebase subtrees**: For each subtree, rebase its claim mask from its anchor to the aggregation anchor (see [conflict module](conflict.md) rebasing). If rebasing detects a conflict (subtree claims an output already spent by the chain), exclude that subtree.
3. **Merge claim masks**: Union all rebased claim masks. If two subtrees claim the same anchor output, they conflict and cannot be aggregated together.
4. **Add own claims**: The aggregation block claims the aggregation incentive outputs from its subtrees.
5. **Compute weight vector**: Attribute each subtree's weight to the correct chain depth based on its anchor position relative to the aggregation anchor.
6. **Set aggregates**: The set of block hashes being replaced.

### Contracts Satisfied

An aggregation block satisfies the aggregation contracts on its subtrees' incentive outputs. These contracts verify that the claiming block aggregates (replaces) the block that produced the output. The aggregation block should claim all available aggregation incentive outputs from its subtrees.

---

## Draft System

A block is created from a **draft** — a description of intent that can be (re)evaluated as canonical state changes.

Drafts are not static specifications. They are better understood as **generator functions**: given the current canonical state, a draft produces a concrete block (or determines that it cannot yet be satisfied). This is necessary because:

- Available outputs change as the canonical view shifts.
- A block that becomes non-canonical may need to be recreated with different inputs.
- New outputs may appear that match a draft's requirements (e.g., a new computation request matching work we've already done).

### Draft State

```
DraftState {
    drafts:       Map<DraftID, DraftGenerator>
    published:    Map<DraftID, Set<BlockHash>>    // blocks created from each draft
    canonicalView: CanonicalView                  // from consensus module
}
```

### Reactive Lifecycle

When the canonical view updates:

1. **Published block check**: For each published block, is it still canonical? If not, the draft may need to produce a new block with different inputs.
2. **Draft evaluation**: For unsatisfied drafts, evaluate against the new canonical state. If inputs are now available, produce a block.
3. **Aggregation opportunities**: As subtrees mature (accumulate descendant weight, have collateral posted), new aggregation drafts may be created.

### Draft Compatibility

Multiple drafts can sometimes be merged into a single block if:
- Their input claims don't overlap.
- They can share the same anchor.
- The combined computation is valid.

Merging reduces block count, gossip overhead, and collateral requirements. However, drafts with different urgency or anchor requirements should remain separate.

The full reactive strategy system (conditional draft generators that respond to canonical state transitions) is documented as future work in [TODO.md](../../TODO.md).

---

## Structural Verification

The structural verification module checks block-specific properties that are computable from the block itself (and its inputs), without running contract WASM. A block is **structurally valid** if:

1. **Anchor reference**: The anchor exists and is well-formed (or absent for genesis).
2. **Claim indices**: All claim indices are valid — self-claims have index < `ownOutputCount`, shared-resource claims have index < `ownOutputCount` + post-subtree vector length.
3. **Claim mask consistency**: `claimMask` correctly represents all claims against anchor outputs (from subtrees and own non-self claims).
4. **Output count**: `outputCount` equals the actual count after full transformation.
5. **Weight vector**: `weight` is correctly derived from `declaredWeight` and subtrees' weight vectors (see Weight Vector).
6. **Throughput balance**: `sum(input_values) == sum(output_values)` (value conservation).
7. **Signature**: The block's signature is valid for the declared creator.
8. **Aggregation structure**: `aggregateOutputCounts` matches the subtrees. Subtree ordering is consistent.

Structural verification does **not** check:
- Whether `declaredWeight` is honest (see [weight.md](weight.md)).
- Whether claimed outputs' contracts accept the block (that's contractual verification).
- Whether the computation produced correct results (that's the verification module).

---

## Collateral Separation

Work and collateral must be in separate blocks. If a work block H is found invalid and removed from the canonical view, any collateral output inside H would also be removed — making it impossible for verifiers to claim fraud rewards. The [trust module](trust.md) enforces this: collateral block C must not be H itself, and must not be a descendant of H.

---

## Module Boundary

### This Module Receives

| Input | Source | Description |
|-------|--------|-------------|
| Canonical view updates | Consensus module | Which blocks are currently canonical |
| Rebase results | Conflict module | Rebased claim masks for aggregation across different anchors |
| Aggregation risk estimates | Trust module | Expected fraud exposure for potential aggregations |
| Contract definitions | Application layer | WASM code defining spending conditions |

### This Module Provides

| Output | Consumer | Description |
|--------|----------|-------------|
| Block anchor + weight vector | Consensus module | Where the block attaches and how much work it claims at each chain level |
| Aggregates set | Consensus module | Which blocks this block replaces |
| Block claim mask | Conflict module | Bit vector of claimed outputs against anchor |
| Block output count | Conflict module | Number of new outputs the block produces |
| Aggregate output counts | Conflict module | Per-subtree output counts for aggregation blocks |
| Subtree ordering | Conflict module | Ordered list of subtrees for sequential transformation |
| Collateral placement (FOR) | Trust module | A separate block vouching for a target block's validity |
| Collateral placement (AGAINST) | Trust module | A separate block alleging invalidity at a specific path |
| New blocks | Gossip module | Blocks to distribute to peers |
| Tree declared work | Sampling module | `declaredWeight` for each tree |

### Invariants

1. **Value conservation**: Every block balances input and output throughput exactly.
2. **Anchor validity**: All claimed outputs exist in the UTXO set at the anchor point.
3. **Weight derivation**: The weight vector is deterministically derived from `declaredWeight` and subtrees.
4. **Claim mask completeness**: `claimMask` includes all claims against anchor outputs from any source within the block.
5. **Self-claim exclusion**: Self-claims (index < `ownOutputCount`) never appear in `claimMask`.
6. **Collateral independence**: Collateral blocks are never the same block as the work they vouch for, and never descendants of it.
7. **Aggregation minimality**: Aggregation blocks have minimal I/O — only what's needed to collect fees and incentivize further aggregation.
