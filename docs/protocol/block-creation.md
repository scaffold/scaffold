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

The wire format carries only structural primitives:

```
Block {
    anchor:         Hash         // parent in the anchor chain (genesis uses the zero hash)
    aggregates:     Hash[]       // blocks this block replaces
    claims:         Index[]      // indices into extended vector (own outputs + post-subtree)
    refs:           Hash[]       // blocks referenced for read-only data access
    outputs:        Output[]     // new outputs this block produces
    declaredWeight: Number       // work this block itself contributes
    creator:        PublicKey    // block creator
    signature:      Signature    // creator's signature over the block
}
```

Blocks are identified by their hash, which is the SHA3-256 digest of the entire serialized [packet](wire-format.md) — including the magic header, type byte, JSON payload, and signature (if present). `outputs.length` gives the block's own output count. Serialization length gives the block size. These are not wire fields.

The `refs` field lists blocks whose outputs this block's contracts may read during execution. References are read-only and do not consume outputs. See [computation](computation.md#cross-block-references).

Domain-specific data — aggregation state (claim masks, weight vectors, output counts), collateral targets, payment targets — is carried in [contract outputs](contracts.md), not block-level fields. Protocol modules access this data through their provider interfaces.

---

## Outputs and Contracts

An **output** is a resource produced by a block:

```
Output {
    verifier:   Verifier     // spending condition
    value:      Number       // economic value
    data:       Bytes | null // application-specific payload, or null
}

Verifier {
    contract:   Hash      // WASM binary hash
    params:     Bytes     // parameters to the contract
}
```

`data` may be `null` for pure-incentive outputs (value-only, invisible to
contracts). Null-data outputs must live in unowned namespaces; see
[null-data outputs](computation.md#null-data-outputs).

A **verifier** defines the spending condition for an output. It combines a contract (identified by its WASM hash) with parameters that configure the condition. For example, a signature contract's params contain the owner's public key. When a block claims an output, the contract WASM is executed with the verifier's params — it accepts or rejects the claim. This is **contractual verification**, distinct from structural verification.

The separation of `params` from `data` is deliberate: `params` parameterizes the spending condition (who/how can claim), while `data` carries the output's payload. See [computation](computation.md#schema) for details.

Contracts are general-purpose. Example contract types:

| Contract | Condition | Use |
|----------|-----------|-----|
| Signature | Block is signed by key in params | Balance, ownership |
| Computation | Block produces valid WASM execution result | Game state, request/response |
| Self | Block is the producing block | Self-claimed key-value data |
| Aggregation | Block aggregates the parent block | Aggregation incentive fees |
| Collateral | Dispute outcome for target block | Validity stakes |
| Timelock | Block's anchor is past depth D | Delayed spending |

The protocol does not define a fixed set of contracts. Any valid WASM that accepts or rejects a block can serve as a contract. The spending condition is entirely determined by the contract code. See [computation](computation.md) for the full computation and verification model.

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

The weight vector attributes work to the correct levels of the anchor chain. It is deterministically computable from the block's `declaredWeight` and its subtrees' weight vectors.

### Leaf Block (no subtrees)

A leaf block has only `declaredWeight`, attributed at depth 0. Its weight vector is `[declaredWeight]`.

### Aggregation Block

Aggregation blocks carry `chainWeights` in their [aggregation contract](contracts.md) output. The `chainWeights` vector captures weight from subtrees only — it excludes the block's own `declaredWeight`.

Each subtree Si is anchored at some depth di relative to this block's anchor (di = 0 means same anchor, di = 1 means the subtree anchors to this block's anchor's anchor, etc.).

```
chainWeights[d] = sum(Si.weight[d - di] for each subtree Si where d >= di)
```

The full weight vector for consensus is reconstructed as:

```
weightVector = [declaredWeight + chainWeights[0], chainWeights[1], ...]
```

### Verification

Weight derivation is verified through the [aggregation contract](contracts.md) — the `chainWeights` in the contract output are checked against the subtrees' weight vectors. This makes weight verification disputable through the same sampling/collateral mechanism as any other computation. The protocol does **not** verify that `declaredWeight` is honest — that is an open design question documented in [weight.md](weight.md).

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
4. **Genesis exclusion**: Genesis cannot be aggregated. Its declared weight is far larger than any tree's, so the weight-ratio balancing constraint always rejects it as an aggregation target. Additionally, an aggregator of genesis would need an anchor that is a descendant of the zero hash, and no such block exists. See [DAG Structure](dag.md).

---

## Aggregation

An aggregation block rolls up multiple subtrees into a single block. It replaces the aggregated blocks in the canonical view, consolidating their weight and compressing the graph. For the full aggregation specification -- total ordering, cache composition, and the aggregation contract -- see [aggregation.md](aggregation.md).

### Design Principle: Minimal I/O

Aggregation blocks should have minimal inputs and outputs beyond what's structurally necessary. This keeps them small, which means faster gossip propagation and lower bandwidth cost. The aggregation block's purpose is structural consolidation, not application logic.

Typical aggregation block I/O:
- **Inputs**: Aggregation marker outputs from the subtrees being aggregated.
- **Outputs**: An aggregation data output (cache) for further aggregation of this block, plus a marker output.

### Construction

At a high level, aggregation construction involves:

1. **Consume markers**: The aggregation contract claims marker outputs from blocks to aggregate via `requireInput()`.
2. **Compose caches**: Read each consumed block's subtree cache, compose into a new cache.
3. **Produce cache output**: The aggregation data output carries the composed cache.
4. **Solidify**: The anchoring module determines the anchor and `aggregates` field from include constraints.

For the detailed composition algorithm, see [aggregation.md](aggregation.md#cache-composition).

### Contracts Satisfied

An aggregation block satisfies the aggregation contracts on its subtrees' marker outputs. The aggregation contract verifies that the claiming block aggregates the block that produced the output. The aggregation block claims all available aggregation marker outputs from its subtrees.

The aggregation block itself produces an aggregation contract output carrying the aggregation cache (claim mask, output count, weight attribution). This data is consumed by the conflict, consensus, and trust modules through their provider interfaces.

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
    drafts:       Map<DraftId, DraftGenerator>
    published:    Map<DraftId, Set<BlockHash>>    // blocks created from each draft
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
- Their contracts' [output namespaces](computation.md#output-namespaces) are disjoint (no two mergeable claims write outputs in the same namespace).
- The combined computation is valid.

The namespace disjointness rule means two claims of the same contract with
different params cannot share a block if the contract declares any output
namespace. A multi-collateral resolution, for example, becomes one block per
collateral target rather than one block that resolves many. Signature-only
(pure gate) contracts declare no namespace and merge freely.

Merging reduces block count, gossip overhead, and collateral requirements. However, drafts with different urgency or anchor requirements should remain separate.

The full reactive strategy system (conditional draft generators that respond to canonical state transitions) is documented as future work in [TODO.md](../../TODO.md).

---

## Structural Verification

The structural verification module checks block-specific properties that are computable from the block itself (and its inputs), without running contract WASM. A block is **structurally valid** if:

1. **Anchor reference**: The anchor exists and is well-formed (genesis anchors to the zero hash).
2. **Claim indices**: All claim indices are valid — self-claims have index < `outputs.length`, shared-resource claims have index < `outputs.length` + post-subtree vector length.
3. **Throughput balance**: `sum(input_values) == sum(output_values)` (value conservation).
4. **Signature**: The block's [packet-level signature](wire-format.md) is valid for the declared creator. Signature verification uses the secp256k1 signature embedded in the packet envelope, verified against the hash of the header+payload portion.
5. **Output namespace partition**: Outputs partition by `verifier.contract`. Within each owned namespace (a namespace H where some claim's contract declares H in its `outputNamespaces`), the sequence of outputs is exactly what the owning contract emitted during its run, matched positionally. Unowned namespaces are governed by other protocol rules (e.g., the mandatory aggregation marker). Null-data outputs (pure-incentive) must live in unowned namespaces -- a null-data output in an owned namespace is a violation since contracts cannot emit null. See [output namespaces](computation.md#output-namespaces) and [null-data outputs](computation.md#null-data-outputs).

Checks that were previously structural — claim mask consistency, output count, weight vector derivation, aggregate output counts — are now [contractual verification](contracts.md). The aggregation contract output carries this data, and its correctness is verified (and disputable) through the same sampling/collateral mechanism as any other contract.

Structural verification does **not** check:
- Whether `declaredWeight` is honest (see [weight.md](weight.md)).
- Whether claimed outputs' contracts accept the block (that's contractual verification).
- Whether the computation produced correct results (that's the verification module).

---

## Collateral Separation

Work and collateral must be in separate blocks. If a work block H is found invalid and removed from the canonical view, any collateral output inside H would also be removed — making it impossible for verifiers to claim fraud rewards. The [trust module](trust.md) enforces this: collateral block C must not be H itself, and must not be a descendant of H.

The separation rule is a property of the [collateral contract's](contracts.md) spending conditions — not a block-level structural constraint.

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

1. **Outputs before claims**: A block's output space is its final, post-claim set of surviving outputs. During construction, the block's own outputs are prepended to the inherited space, forming the extended vector. Claims are applied as removals from this extended vector. Claim indices in `block.claimIndices` refer to positions in the extended vector, not in the final output space. This ordering enables self-claiming.
2. **Value conservation**: Every block balances input and output throughput exactly.
3. **Anchor validity**: All claimed outputs exist in the UTXO set at the anchor point.
4. **Weight derivation**: The weight vector is deterministically derived from `declaredWeight` and subtrees (verified via the [aggregation contract](contracts.md)).
5. **Claim mask completeness**: The claim mask (in the aggregation contract output) includes all claims against anchor outputs from any source within the block.
6. **Self-claim exclusion**: Self-claims (index < `outputs.length`) never appear in the claim mask.
7. **Collateral independence**: Collateral blocks are never the same block as the work they vouch for, and never descendants of it (enforced by the [collateral contract](contracts.md)).
8. **Aggregation minimality**: Aggregation blocks have minimal I/O — only what's needed to collect fees and incentivize further aggregation.
9. **Output namespace partition**: For every contract H owned on the block (via some claim's contract declaring H in its `outputNamespaces`), the block's outputs under H equal exactly the owning contract's emitted sequence, matched positionally. At most one contract owns any namespace on a given block. See [output namespaces](computation.md#output-namespaces).

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/BlockCreationModule.ts`](../../src/core/BlockCreationModule.ts) | Core algorithm: block construction, weight vector derivation, claim masks |
| [`src/core/BlockCreationService.ts`](../../src/core/BlockCreationService.ts) | Wired adapter using concrete `Block` type |
| [`src/core/Block.ts`](../../src/core/Block.ts) | Block data structure, `BlockStore`, genesis creation |
