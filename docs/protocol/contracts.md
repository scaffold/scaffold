# Standard Contracts

Contracts are general-purpose spending conditions. Any valid WASM program that accepts or rejects a block can serve as a contract. The protocol does not privilege specific contracts — but the protocol's own modules (conflict, consensus, trust, gossip) know how to interpret the standard contracts defined here.

Standard contracts are **conventions**, not protocol primitives. They carry domain-specific data in the output's `data` field that the protocol's modules consume through their provider interfaces. Each output has a **verifier** (contract hash + params) that defines its spending condition, separate from the `data` payload. See [computation](computation.md) for the full schema.

---

## Contract Registration

A contract is introduced to the network via a **contract block** -- a block
that publishes the WASM binary together with its static metadata. The
contract's hash is the hash of its WASM binary; that hash is what every
`verifier.contract` field references.

The contract block carries record outputs keyed for generic consumption:

| Record key | Data |
|------------|------|
| `contract:wasm` | The WASM binary. |
| `contract:outputNamespaces` | Encoded `Hash[]` -- the contract's declared output namespaces. See [output namespaces](computation.md#output-namespaces). |
| `contract:walker` / `contract:builder` | Optional walker/builder exports for observability and construction. See [output data](output-data.md). |
| `contract:costHint` | Optional verification cost estimate for sampling priority. |

Any node that needs to load contract H:
1. Resolves the contract block via H (using the hash-lookup mechanism from
   the host handler chain -- blob registry first, then peers).
2. Reads the records above.
3. Caches the WASM and metadata locally.

Because the declarations are themselves record outputs, they fit the "records
are a per-contract key-value map" semantics described in the [record
contract](#record-contract-aka-self-contract). The block that publishes the
contract owns the `RECORD_CONTRACT` namespace on that block and is therefore
the sole author of these records -- no other contract running on the same
block could fake them.

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

## Collateral Contract

**Purpose**: FOR/AGAINST validity stakes on a target block. FOR is the author's collateral (decays back if unchallenged). AGAINST is a challenger's bond contesting a specific aspect of the block.

**Verifier params**: The target block hash. All FOR and AGAINST postings for the same target share the same verifier, so `collectInputs()` returns them all.

**Detail (FOR)**:
```
{ side: 'for', pubkey: PublicKey }
```

**Detail (AGAINST)**:
```
{
    side:       'against',
    target:     ChallengeTarget,
    pubkey:     PublicKey
}

ChallengeTarget =
    | { type: 'validity' }
    | { type: 'anchor' }
    | { type: 'ref', index: Number }
    | { type: 'aggregate', index: Number }
    | { type: 'output_verifier_contract', index: Number }
```

**Spending conditions** (see [collateral-resolution](collateral-resolution.md)):
- **Decay return**: Author reclaims `C1 * exp(-c * age)` if no AGAINST exists.
- **Hash challenge response**: Responder reveals preimage, earns AGAINST bond. FOR unaffected.
- **Unresolved challenge**: Challenger claims decayed FOR (locked at challenge timestamp) + AGAINST bond.
- **Non-canonical reclaim**: Full return to both sides. No penalty.

The separation rule (collateral block C must not be the target H or a descendant of H) is enforced by the contract. AGAINST challenges double as data queries -- posting AGAINST on a hash requests its preimage.

---

## Insurance Contract

**Purpose**: Risk transfer deposit. Author posts insurance; aggregator claims it, returns most to the author minus a fee, and posts their own insurance covering the subtree.

**Verifier params**: The target block hash (author's deposit) or aggregation tree root (aggregator's coverage).

**Detail**:
```
{ pubkey: PublicKey }    // owner (author or aggregator)
```

**Spending conditions** (see [collateral-resolution](collateral-resolution.md)):
- **Aggregation claim**: Aggregator claims author's insurance (1000), returns most (995) to author, keeps fee (5 = v * T / T_avg). Aggregator posts own insurance for the tree.
- **Rectification payout**: A block in the insured tree is proven invalid (via collateral resolution). Pays finder's reward + victim restoration.
- **Non-canonical reclaim**: Full return.
- **Solidification return**: Aggregator reclaims after sufficient time without challenges.

---

## Computation Contract

Any application-specific WASM that exports `verify()` is a computation contract. The contract defines its own verification logic — game tick simulation, hash checking, proof verification, etc. The contract WASM hash identifies the contract.

See [computation](computation.md) for the full specification: dual-mode execution, self-claimed outputs, cross-block references, the WASM host interface, and examples.

## Record Contract (a.k.a. Self Contract)

**Purpose**: Self-claimed key-value outputs — produced and consumed atomically by the same block. Acts as the producing contract's per-block key-value map.

**Verification**: Every input matching this contract's verifier must be a self-claim (claimed on the same block that produced it).

**Verifier params**: A key (arbitrary bytes) identifying this entry in the block's key-value store.

**Detail**: The value (arbitrary bytes) associated with the key.

**Output namespace owner**: any contract whose `outputNamespaces` metadata includes `RECORD_CONTRACT`. Because an output namespace has at most one owning contract per block (see [output namespaces](computation.md#output-namespaces)), **at most one record-emitting contract can run on a block**. Two contracts that both want to emit records must live on separate blocks.

This strictness is intentional. Optional records -- a record whose presence or absence carries meaning to a downstream reader -- are only trustworthy if no other contract on the block could forge the key. Allowing multiple record-emitting contracts per block would let one contract fill in a key that another contract deliberately omitted. Restricting to one owner per block eliminates the forgery.

Downstream self-claiming is handled by the block-assembly layer, not the contract. A record output is trivially self-claimable (the SELF/RECORD spending condition is "the claiming block is the producing block"), so assembly adds the self-claim as a matter of course. Contracts call `require_result(key, value)` -- sugar for `add_output({RECORD_CONTRACT, key}, 0, value)` -- without worrying about claim bookkeeping.

Other blocks read these outputs via [cross-block references](computation.md#cross-block-references).

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
| [Trust](trust.md) | Aggregation (aggregateWeights), Collateral (target, side, decay), Insurance (target, coverage) | Evaluate child weights, manage collateral lifecycle |
| [Gossip](gossip.md) | Aggregation (chainWeights), Signature (publicKey), Collateral (target) | Priority scoring for block distribution |
| [Sampling](sampling.md) | (none — uses block.declaredWeight directly) | Verification priority |

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/Block.ts`](../../src/core/Block.ts) | `AGGREGATION_CONTRACT` hash |
| [`src/contracts/AggregationContract.ts`](../../src/contracts/AggregationContract.ts) | `AggregationData` type, encode/decode helpers |
| [`src/core/BlockCreationModule.ts`](../../src/core/BlockCreationModule.ts) | Produces aggregation contract output during block construction |
| [`src/core/ConsensusService.ts`](../../src/core/ConsensusService.ts) | Reconstructs weight vector from `declaredWeight` + `chainWeights` |
| [`src/node/GossipService.ts`](../../src/node/GossipService.ts) | Scans outputs for collateral target and payment target |
| [`src/core/TrustService.ts`](../../src/core/TrustService.ts) | Reads `aggregateWeights` from aggregation contract output |
