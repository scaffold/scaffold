# Standard Contracts

Contracts are general-purpose spending conditions. Any valid WASM program that accepts or rejects a block can serve as a contract. The protocol does not privilege specific contracts — but the protocol's own modules (conflict, consensus, trust, gossip) know how to interpret the standard contracts defined here.

Standard contracts are **conventions**, not protocol primitives. They carry domain-specific data in the output's `detail` field that the protocol's modules consume through their provider interfaces. Each output has a **verifier** (contract hash + params) that defines its spending condition, separate from the `detail` payload. See [computation](computation.md) for the full schema.

---

## Signature Contract

**Purpose**: Balance ownership. The simplest spending condition.

**Verification**: The claiming block's signature matches the public key in the verifier params.

**Verifier params**: The owner's public key.

**Detail**: Empty (or application-specific metadata).

This is the "payment contract" — an output spendable only by the holder of a specific private key. Used for balance transfers, fee collection, and any case where ownership is the spending condition.

---

## Aggregation Contract

**Purpose**: Incentivize aggregation. The output can only be claimed by a block that aggregates its parent.

**Verification**: The claiming block's `aggregates` set includes the block that produced this output.

**Output data**: The aggregation contract output carries the **aggregation summary** — cached UTXO transformation state computed from the subtrees:

```
AggregationData {
    claimMask:              MerkleRoot   // composed claim mask (subtree + own claims rebased and merged)
    outputCount:            Number       // total outputs after full transformation
    aggregateOutputCounts:  Number[]     // per-subtree output counts
    chainWeights:           Number[]     // weight vector from subtrees only (excludes own declaredWeight)
    aggregateWeights:       Number[]     // per-subtree declared weights
}
```

**Key insight**: This data depends **only on the subtrees**, not on the aggregator's own claims/outputs. The aggregation contract reads subtrees' aggregation data (descending the merkle tree), their inputs and outputs, and computes the merged result. This makes it cleanly separable from the block's economic activity.

The `chainWeights` vector excludes the block's own `declaredWeight`. The full weight vector for consensus is reconstructed as: `[declaredWeight + chainWeights[0], chainWeights[1], ...]`.

**Reasoning**: Moving claim mask composition and weight attribution into a contract output makes them verifiable and disputable through the same sampling/collateral mechanism as any other computation. The tradeoff (structural → contractual verification) is acceptable because: (a) the system already handles partial claim mask knowledge, (b) collateral makes incorrect aggregation data costly, (c) it is consistent with how all other contract verification works.

---

## Verifier Reward Contract

**Purpose**: Publisher's short-term validity stake. Decays back to the publisher if unchallenged.

**Verifier params**: The target block hash.

**Detail**: The publisher's public key (where to remit funds on decay return).

**Spending conditions** (see [collateral-resolution](collateral-resolution.md)):
- **Decay return**: Publisher reclaims `C1 * exp(-c * age)` if no active challenges exist.
- **Challenge claim**: An AGAINST challenge was posted and not responded to. Challenger claims the decayed remainder (locked at challenge timestamp).
- **Non-canonical reclaim**: Target block becomes non-canonical. Full return, no penalty.

The separation rule (collateral block C must not be the target H or a descendant of H) is a property of this contract's spending conditions.

---

## Rectification Contract

**Purpose**: Long-term insurance for invalid blocks. Funded by the aggregation fee.

**Verifier params**: The target block hash (individual fee output) or aggregation tree root (accumulated pot).

**Detail**: The owner's public key (publisher for fee output, aggregator for pot).

**Spending conditions** (see [collateral-resolution](collateral-resolution.md)):
- **Aggregation claim**: Aggregator claims the fee output during aggregation, rolls into their rectification pot.
- **Rectification payout**: A block in the covered tree is proven invalid. Creates finder's reward + victim restoration outputs.
- **Non-canonical reclaim**: Full return if the aggregation tree becomes non-canonical.
- **Solidification return**: After sufficient time without challenges, aggregator reclaims.

---

## Challenge Contract

**Purpose**: AGAINST bond targeting a specific hash or validity claim in a block.

**Verifier params**:
```
CollateralParams {
    coveredBlockHash: Hash       // the block this collateral covers
}
```

**Detail**:
```
ChallengeDetail {
    target:     ChallengeTarget    // discriminated union (see below)
    pubkey:     PublicKey           // challenger's pubkey for remittance
}

ChallengeTarget =
    | { type: 'validity' }
    | { type: 'anchor' }
    | { type: 'ref', index: Number }
    | { type: 'aggregate', index: Number }
    | { type: 'output', index: Number }
```

**Spending conditions**:
- **Hash response**: Anyone reveals the preimage matching the targeted hash. `hash(preimage) == target_hash`. Self-resolving. Responder earns the bond.
- **Validity response**: Re-execution proves the block's computation is correct. Responder earns the bond.
- **Unclaimed return**: If the challenge is old enough that the corresponding verifier reward has fully decayed, the challenger can reclaim their bond (the challenge is moot).

---

## Computation Contract

Any application-specific WASM that exports `verify()` is a computation contract. The contract defines its own verification logic — game tick simulation, hash checking, proof verification, etc. The contract WASM hash identifies the contract.

See [computation](computation.md) for the full specification: dual-mode execution, self-claimed outputs, cross-block references, the WASM host interface, and examples.

## Self Contract

**Purpose**: Mark outputs as self-claimed — produced and consumed atomically by the same block.

**Verification**: The claiming block must be the producing block.

**Verifier params**: A key (arbitrary bytes) identifying this entry in the block's key-value store.

**Detail**: The value (arbitrary bytes) associated with the key.

Self-claimed outputs store computation results. Other blocks read them via [cross-block references](computation.md#cross-block-references). See [computation](computation.md#self-claimed-outputs).

---

## Timelock Contract

**Purpose**: Output spendable only after the anchor reaches a minimum depth.

**Verification**: The claiming block's anchor chain includes the timelocked block's anchor at depth ≥ D.

**Verifier params**:
```
TimelockParams {
    minDepth:   Number     // minimum anchor chain depth before spending is allowed
}
```

**Detail**: Application-specific or empty.

Used for delayed spending, vesting schedules, and cases where finality confidence requires waiting.

---

## Relationship to Protocol Modules

Each protocol module interacts with contract output data through its provider interface:

| Module | Contract Data Used | How |
|--------|-------------------|-----|
| [Conflict](conflict.md) | Aggregation (claimMask, outputCount, aggregateOutputCounts) | Detect double-spends via claim mask overlap |
| [Consensus](consensus.md) | Aggregation (chainWeights) | Reconstruct weight vector for branch selection |
| [Trust](trust.md) | Aggregation (aggregateWeights), Verifier Reward (target, decay), Rectification (target, pot), Challenge (target, type) | Evaluate child weights, manage collateral lifecycle |
| [Gossip](gossip.md) | Aggregation (chainWeights), Signature (publicKey), Verifier Reward (target) | Priority scoring for block distribution |
| [Sampling](sampling.md) | (none — uses block.declaredWeight directly) | Verification priority |

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/Block.ts`](../../src/core/Block.ts) | `AggregationData` type, encode/decode helpers, `AGGREGATION_CONTRACT` hash |
| [`src/core/BlockCreationModule.ts`](../../src/core/BlockCreationModule.ts) | Produces aggregation contract output during block construction |
| [`src/core/ConsensusService.ts`](../../src/core/ConsensusService.ts) | Reconstructs weight vector from `declaredWeight` + `chainWeights` |
| [`src/core/GossipService.ts`](../../src/core/GossipService.ts) | Scans outputs for collateral target and payment target |
| [`src/core/TrustService.ts`](../../src/core/TrustService.ts) | Reads `aggregateWeights` from aggregation contract output |
