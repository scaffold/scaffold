# Computation and Verification

This document specifies how computation works in Scaffold: how blocks produce and verify results, how contracts enforce correctness, and how the collateral system incentivizes honest computation.

For context on the block structure, outputs, and contracts, see [block creation](block-creation.md) and [contracts](contracts.md). For the collateral lifecycle, see [trust](trust.md). For the verification incentive model, see [deception](deception.md).

---

## Overview

Every computation in Scaffold has two sides:

- **Generation**: Producing the result. This can be anything — WASM, JavaScript, GPU-accelerated native code, or even a human providing input. The protocol does not constrain how results are generated.
- **Verification**: Checking the result. This is always a WASM contract. It must be deterministic — given the same inputs, it always produces the same accept/reject decision.

The same WASM can serve both roles (the common case for pure computations like game ticks), but the protocol only requires the verification side. A GPU-accelerated physics engine might generate results, while a simpler WASM contract verifies them.

### Dual-Mode Execution

Contract WASM runs in two modes:

- **Generation mode**: The contract constructs the block. Host functions like `set_data()` write values; `add_output()` creates outputs.
- **Verification mode**: The contract checks an existing block. Host functions like `set_data()` verify values match; `add_output()` checks the output exists.

The developer writes one function that works in both modes. The host's behavior differs, not the contract code. The mode is exposed for contracts that need to branch (e.g., contracts that only implement verification, or that skip expensive generation-only work during verification).

---

## Schema

### Block

```
Block {
    anchor:         Hash         // parent in the anchor chain
    aggregates:     Hash[]       // blocks this block replaces
    claims:         Index[]      // indices into extended output vector
    refs:           Hash[]       // referenced blocks (read-only data access)
    outputs:        Output[]     // new outputs this block produces
    declaredWeight: Number       // work this block contributes
    creator:        PublicKey    // block creator
    signature:      Signature    // creator's signature over the block
}
```

The `refs` field is new. It lists blocks whose outputs this block's contracts may read during execution. References are read-only — they do not consume outputs. See [Cross-Block References](#cross-block-references).

### Output

```
Output {
    verifier:   Verifier         // spending condition
    value:      Number           // economic value
    detail:     Uint8Array       // application-specific payload
}
```

An output's spending condition is defined by its **verifier**, which replaces the previous bare contract hash.

### Verifier

```
Verifier {
    contract:   Hash             // WASM binary hash
    params:     Uint8Array       // parameters passed to the contract
}
```

A verifier combines the contract WASM (identified by hash) with parameters that configure the spending condition. For example, a signature contract's params contain the public key; two outputs can use the same signature contract WASM with different public keys.

The separation of `params` from `detail` is deliberate:
- **`params`** parameterizes the spending condition (who/how can you claim this output).
- **`detail`** carries the output's payload data (what information does this output hold).

---

## Self-Claimed Outputs

Computation results are stored as **self-claimed outputs** — outputs that a block produces and claims atomically in the same block. The self-claim mechanism is already part of the protocol (see [block creation: output transformation](block-creation.md#output-transformation)).

A self-claimed output uses a well-known SELF contract whose spending condition is: the claiming block must be the producing block. The verifier's `params` field acts as a key, and the output's `detail` field acts as the value, creating a key-value store for computation results.

```
// Self-claimed output example: storing game state
Output {
    verifier: { contract: SELF_CONTRACT, params: encode("state") },
    value: 0,
    detail: <game_state_bytes>
}
```

A block can have multiple self-claimed outputs with different keys:

```
Block outputs:
  [0] { verifier: SELF/"state",  value: 0, detail: <game_state> }     // self-claimed
  [1] { verifier: SELF/"tick",   value: 0, detail: <tick_number> }     // self-claimed
  [2] { verifier: GAME/config,   value: 10, detail: <next_request> }   // regular output
Block claims: [0, 1, ...]   // self-claim indices 0 and 1
```

Other blocks can read these self-claimed outputs by referencing this block (see [Cross-Block References](#cross-block-references)). The outputs are consumed (not claimable by other blocks), but their data remains readable.

### Why Self-Claimed Outputs Instead of a Block-Level Data Field

An earlier design considered adding a `data: Uint8Array` field directly to the block. Self-claimed outputs are preferable because:

1. **No block schema change** — uses the existing output/claim mechanism.
2. **Key-value semantics** — a block can expose multiple named results, not just one byte array.
3. **Unified model** — computation results, merkle tree nodes, and regular outputs all use the same mechanism.
4. **Natural fit** — the self-claim pattern is already specified and implemented.

---

## Cross-Block References

A block's `refs: Hash[]` field lists other blocks whose data this block's contracts need to read. References are:

- **Read-only**: They do not consume outputs. The referenced block's outputs remain in whatever state they were in (claimed or unclaimed).
- **Explicit**: Listed in the block structure. No implicit discovery during verification.
- **Deterministic**: During generation, the builder discovers referenced blocks via network lookup. Once the block is published, the refs are fixed. Verification reads from the same fixed set.

### Host Functions for References

Contracts access referenced blocks' outputs through host functions:

```
ref_count() → u32
ref_output_count(ref_index) → u32
ref_output_detail(ref_index, output_index) → bytes
ref_output_verifier(ref_index, output_index) → (hash, bytes)
```

A contract can iterate a referenced block's outputs, find the one with the expected verifier, and read its detail. For example, reading a previous game state:

```
// In game tick contract:
for i in 0..ref_output_count(0) {
    let (contract, params) = ref_output_verifier(0, i);
    if contract == SELF_CONTRACT && params == "state" {
        let prev_state = ref_output_detail(0, i);
        // ... use prev_state
    }
}
```

### Replacing Oracle Logs

Cross-block references replace the oracle log concept from earlier brainstorming. Instead of recording external data fetched during execution, the block explicitly references other blocks whose data it used. The referenced data is immutable once published, so verification is deterministic without a separate replay mechanism.

---

## Contract WASM Interface

### Required Export

```
verify() → void
```

The contract must export a `verify` function. The host calls it with the execution context populated. The function uses host functions to read inputs, check or produce outputs, and terminates with `accept()` or `reject()`.

### Host Functions (Imports)

#### Mode and Context

```
get_mode() → u32                    // 0 = Generation, 1 = Verification
current_contract() → (ptr, len)     // this contract's WASM hash
current_params() → (ptr, len)       // this verifier's params
```

#### Self-Claimed Output Data

```
set_data(key_ptr, key_len, value_ptr, value_len) → void
```

Adds a self-claimed output with verifier `(SELF_CONTRACT, key)` and detail `value`. In generation mode, creates the output and adds a self-claim. In verification mode, checks that a matching self-claimed output exists with the expected detail.

#### Claimed Outputs

```
claimed_output_count() → u32
claimed_output_detail(index) → (ptr, len)
claimed_output_verifier(index) → (contract_ptr, contract_len, params_ptr, params_len)
```

Iterate over all outputs being claimed by this block. The contract can read each claimed output's detail and verifier to validate the claim.

#### Output Requirements

```
add_output(contract_ptr, contract_len, params_ptr, params_len,
           value, detail_ptr, detail_len) → void
```

In generation mode, creates an output on the block. In verification mode, checks that a matching output exists (same verifier, value, and detail).

#### Constraints

```
require_signature(pubkey_ptr, pubkey_len) → void
require_min_timestamp(value) → void
```

Assert that the block satisfies a constraint. `require_signature` checks the block's signature matches the given public key. `require_min_timestamp` checks the block's position satisfies a minimum time requirement.

#### Cross-Block References

```
ref_count() → u32
ref_output_count(ref_index) → u32
ref_output_detail(ref_index, output_index) → (ptr, len)
ref_output_verifier(ref_index, output_index) → (contract_ptr, contract_len,
                                                  params_ptr, params_len)
```

Read outputs from referenced blocks. See [Cross-Block References](#cross-block-references).

#### Terminal

```
accept() → void
reject() → void
```

End execution. `accept()` means the spending condition is satisfied. `reject()` means it is not. Execution must terminate with exactly one of these.

---

## Verification Flow

When a block claims outputs, each claimed output's contract runs independently:

1. The host loads the contract WASM identified by the output's `verifier.contract`.
2. The host passes the verifier's `params` via `current_params()`.
3. The contract executes, reading claimed outputs, checking constraints, and validating the block's self-claimed data and outputs.
4. The contract calls `accept()` or `reject()`.
5. **All** claimed output contracts must accept for the block to be valid.

Most simple contracts (signature checks) do not constrain the block's self-claimed outputs — they only check the signature. Complex contracts (game ticks) validate that the self-claimed state is a correct computation given the inputs.

If two claimed outputs' contracts would require different self-claimed data values, they are incompatible and cannot be on the same block.

---

## Easy and Hard Contracts

Contracts vary in verification cost:

**Easy contracts** are trivial to verify — a signature check, a hash comparison, a simple arithmetic constraint. Verification takes negligible resources. These do not require collateral because any peer can quickly verify them.

**Hard contracts** require significant resources to verify — seconds of CPU time, large memory, or complex computation. A game tick simulation, a program compilation check, or a cryptographic proof verification. These require the publisher to post collateral, because:

1. Other peers cannot cheaply verify the result.
2. Without collateral, there is no economic consequence for publishing wrong results.
3. The collateral funds the [deception game](deception.md) that incentivizes verification.

Whether a contract is "easy" or "hard" is not a protocol-level flag — it is determined by the contract's actual verification cost. The convention is: if verification takes more than trivial resources, the publisher should post collateral.

---

## Collateral and Dispute Resolution

The collateral system has two complementary layers. For the collateral lifecycle and mechanics, see [trust](trust.md). For the game-theoretic incentive model, see [deception](deception.md).

### Layer 1: Deception Game

Publishers occasionally publish intentionally wrong results. If nobody catches the fraud, the publisher self-catches and claims a jackpot from the aggregator's collateral. This funds the verification layer — verifiers are incentivized to check results because catching fraud is profitable. See [deception](deception.md) for the equilibrium analysis.

### Layer 2: VALID/INVALID Voting

Non-descendant blocks post collateral on a target block, asserting either **VALID** or **INVALID**:

```
Collateral output:
  verifier: { contract: COLLATERAL_CONTRACT, params: encode(target_hash) }
  value: <stake_amount>
  detail: encode({ side: VALID | INVALID, pubkey: <remittance_key> })
```

The **non-descendant requirement** is critical: if the target block becomes invalid, the collateral block must not be invalidated along with it. This is enforced by the [collateral contract's](contracts.md) spending conditions.

For hard contracts, the publisher **must** post VALID collateral on their own block. Without publisher collateral, other peers have no reason to trust the result — there is no economic consequence for fraud.

### Resolution

After a resolution event (aggregation or time-based deadline), a **collateral resolution block** claims all collateral outputs referencing the target:

1. Sum the VALID stakes and INVALID stakes.
2. The side with the greater total stake wins — this determines the block's effective validity.
3. The resolution contract requires outputs directing the total collateral to the winners' remittance keys.

The resolution algorithm's details (proportional vs. winner-take-all distribution, minimum stakes, timing) are open design questions. The core mechanism is: majority by stake wins, losers' collateral is redistributed to winners.

### Incentive

When a resolution is contested (some vote VALID, some INVALID), every additional voter can potentially profit. If you can determine the correct validity and the current minority is correct, voting with them can flip the outcome — winning you the majority's stakes. This creates a self-correcting economic pressure toward the correct answer.

---

## Required Outputs

Contracts can require the claiming block to produce specific outputs. The contract calls `add_output()` during execution; in verification mode, this checks that the expected output exists.

### Use Cases

**Fund direction**: A collateral resolution contract computes the winning side and requires outputs directing funds to the winners:

```
// In resolution contract:
for winner in winners {
    add_output(SIGNATURE_CONTRACT, winner.pubkey, winner.share, empty);
}
accept();
```

**Hash proofs**: An output whose contract is valid only if the claiming block contains data hashing to H:

```
// Hash-lock contract:
let data = claimed_output_detail(0);  // or read from self-claimed output
if hash(data) != current_params() {   // params = expected hash H
    reject();
}
accept();
```

**Merkle trees**: Combine hash-lock contracts with a merkle node structure. Each merkle node block self-claims its data and outputs to hash-lock contracts for its children. If any child hash is invalid, the child's funds are not claimable and are forfeit. This constructs a verifiable merkle tree from blocks.

---

## Query and Promise Mechanism

> Status: design discussion. Not yet specified.

For offline state (data the publisher holds but did not publish in full), two outputs work together:

- A **promise output** commits to data (e.g., a merkle root) alongside the block.
- A **query output** can be posted by any peer requesting specific data (e.g., a merkle branch).

While a query is posted but unanswered, the original block's effective weight is reduced. This incentivizes the publisher to respond quickly with the requested data.

The exact mechanism — how weight reduction works, query format, response validation, and the relationship between queries and challenges — is an open design question. See the [brainstorming notes](../../brainstorming/compute/explorations/03-offline-state-and-challenge-lifecycle.md) for analysis of the challenge vs. query distinction.

---

## Aggregation Ordering

Aggregation blocks should order their subtrees by downstream weight (heaviest first). This ordering:

1. Provides a canonical ordering within the aggregation tree.
2. Is used by the collateral resolution contract to determine the sequence in which disputes are resolved.
3. Is deterministically verifiable from the subtrees' weight vectors.

This interacts with the existing weight-ratio balancing constraint from [DAG structure](dag.md) — the ordering is within the set of subtrees that already satisfy the weight-ratio constraint.

---

## Observability

Contracts can optionally export functions for generic tools (block explorers, debuggers, CLI) to inspect output data without contract-specific decoders. Two approaches are supported:

### Option 1: JSON Serialization

The contract exports `toJson` and `fromJson` functions for each data type (params, detail, self-claimed values). Simple, but adds 14–100 KB to the WASM binary for JSON encoding/decoding.

### Option 2: Host-Driven Walker (Preferred)

The contract walks its data structure, calling host-imported functions for each branch and leaf:

```
// Contract exports:
walk_detail(detail_ptr, detail_len) → void
walk_params(params_ptr, params_len) → void

// Host-imported functions used by the walker:
emit_map_start(key_ptr, key_len) → bool     // returns false to skip this branch
emit_map_end() → void
emit_string(key_ptr, key_len, value_ptr, value_len) → void
emit_number(key_ptr, key_len, value) → void
emit_bytes(key_ptr, key_len, value_ptr, value_len) → void
emit_list_start(key_ptr, key_len, count) → bool
emit_list_end() → void
```

The host decides which branches to descend (returning `false` from `emit_map_start` to skip). This supports lazy exploration of large or infinite data structures. For large or paginated data, the WASM can request specific keys to descend into.

Both approaches are optional. See [output data format](output-data.md) for the existing contract-as-explorer design.

---

## Examples

### Game Tick

A game tick contract verifies that `state_N+1` is a valid successor to `state_N` given player moves.

```
Block:
  claims: [0, 1, 2, 3]
  refs: [<block containing state_N>]
  outputs:
    [0] { SELF/"state", 0, <state_N+1> }          // self-claimed: new state
    [1] { SELF/"tick",  0, <tick_number> }          // self-claimed: tick counter
    [2] { GAME/config, bounty, <next_request> }     // claimable: next tick request
    [3] { SIGNATURE/creator, fee, empty }            // claimable: creator's fee
```

The game tick contract:
1. Reads `state_N` from `ref_output_detail(0, state_output_index)`.
2. Reads player moves from `claimed_output_detail(...)` (claiming move outputs).
3. Computes `state_N+1`.
4. Calls `set_data("state", state_N+1)` — in gen mode creates the self-claimed output; in verify mode checks it matches.
5. Calls `set_data("tick", tick_number)`.
6. Calls `add_output(GAME, config, bounty, next_request)` — the next tick's request.
7. Calls `accept()`.

### Hash Lookup

A peer wants data matching hash H. A block publishes a hash-locked output with a bounty:

```
Request block:
  outputs:
    [0] { HASH_LOCK/H, bounty, empty }   // claimable by anyone who provides data hashing to H
```

Response block:
```
  claims: [<hash_lock_output>]
  outputs:
    [0] { SELF/"data", 0, <the_actual_data> }      // self-claimed
    [1] { SIGNATURE/responder, bounty, empty }      // responder claims bounty
```

The HASH_LOCK contract checks that `hash(claimed_self_data("data")) == params` (the hash H).

### Collateral Resolution

After a dispute deadline, a resolution block claims all VALID/INVALID collateral for a target:

```
Resolution block:
  claims: [<valid_1>, <valid_2>, <invalid_1>]   // all collateral for target
  refs: [<target_block>]
  outputs:
    // Winners receive proportional shares
    [0] { SIGNATURE/winner1_pubkey, share1, empty }
    [1] { SIGNATURE/winner2_pubkey, share2, empty }
```

The resolution contract:
1. Iterates claimed outputs, summing VALID and INVALID stakes.
2. Determines the winning side (majority by stake).
3. Calls `add_output()` for each winner's share.
4. Calls `accept()`.

---

## Interaction with Other Modules

| Module | Impact |
|--------|--------|
| [Block Creation](block-creation.md) | `refs` added to block structure. Output gains `verifier` (contract + params) and `detail` (renamed from `data`). Self-claims used for computation results. |
| [Contracts](contracts.md) | Computation contract placeholder replaced by this spec. Standard contracts updated to use verifier/detail terminology. New SELF contract for self-claimed outputs. |
| [Consensus](consensus.md) | No change. Consumes weight vectors as before. |
| [Conflict](conflict.md) | No change. Self-claimed outputs follow existing self-claim rules. Refs do not participate in conflict detection. |
| [Trust](trust.md) | VALID/INVALID collateral with resolution mechanism. Publisher must post VALID collateral for hard contracts. |
| [Sampling](sampling.md) | Verification cost varies by contract. Hard contracts are more expensive to sample. Priority formula may factor in verification cost. |
| [Gossip](gossip.md) | Needs extension for contract-hash-based routing: peers advertise which contracts they serve. |
| [Deception](deception.md) | Insurance commitments on FOR collateral blocks. Self-catch mechanism for trap blocks. |

---

## Implementation

This is a design specification. No implementation exists yet.

| File | Description |
|------|-------------|
| `src/core/Block.ts` | Needs update: Output type (verifier + detail), Block type (refs), SELF_CONTRACT hash |
| `src/core/BlockCreationModule.ts` | Needs update: self-claimed output construction, refs handling |
| Future: WASM runtime | Contract execution engine with host function bindings |
| Future: Verification module | Sampling-driven verification of computation blocks |
