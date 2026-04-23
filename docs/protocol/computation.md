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
    data:       Uint8Array       // application-specific payload
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

The separation of `params` from `data` is deliberate:
- **`params`** parameterizes the spending condition (who/how can you claim this output).
- **`data`** carries the output's payload (what information does this output hold).

---

## Output Namespaces

Every contract declares, as part of its static metadata, the set of output
contract hashes it is permitted to produce:

```
ContractMeta {
    outputNamespaces: Hash[]    // contract hashes this contract may produce
    // ... walker/builder descriptors, cost hints, etc.
}
```

The declaration is published alongside the contract's WASM (as record outputs
on the block that introduces the contract; see [contracts](contracts.md#contract-registration)).
The set is an **exact closed set**: the contract may produce only outputs
whose `verifier.contract` is in this list; no output outside the list; nothing
else may produce outputs inside the list on the same block.

### Namespace Ownership Rule

A block's outputs partition by `verifier.contract`. For every contract hash
H that is *owned* on this block (i.e., some claim on the block invokes a
verifier whose `contract == H'` where H is in H'`s `outputNamespaces`), the
block's outputs under H **must equal exactly** the sequence the owning
contract declared during its run, matched positionally.

A contract hash with no owner on the block is **unowned** on that block. Its
outputs are governed by whatever other protocol rules apply (e.g., every
non-genesis block carries one `AGGREGATION_CONTRACT` marker). Unowned
namespaces are the mechanism for block-level protocol outputs that no
contract computed.

### Draft Merger

Two drafts are mergeable into a single block iff their `outputNamespaces`
sets are disjoint. If the intersection is non-empty, the claims must live on
separate blocks. One consequence: two claims of the same contract with
different params (e.g., resolving collateral on two different target blocks)
cannot share a block if that contract declares any output namespace.

### Implications

- **Attribution is structural.** Given a block and its claims, every output's
  producer is known by the partition. No re-execution needed.
- **Records are collision-free by construction.** A contract that emits
  records declares `RECORD_CONTRACT` in its namespaces. Two record-emitting
  contracts cannot coexist on a block, so record keys never collide across
  producers. Optional records are meaningful -- a reader checking for the
  absence of a key cannot be deceived by a second contract forging it.
- **Multiple identical outputs are honest.** If one contract calls
  `requireOutput({SIGNATURE/alice, 5})` twice, the block has two `{SIGNATURE/alice, 5}`
  outputs. No merging, no overpayment confusion.

---

## Self-Claimed Outputs

Computation results are stored as **self-claimed outputs** — outputs that a block produces and claims atomically in the same block. The self-claim mechanism is already part of the protocol (see [block creation: output transformation](block-creation.md#output-transformation)).

A self-claimed output uses a well-known SELF contract whose spending condition is: the claiming block must be the producing block. The verifier's `params` field acts as a key, and the output's `data` field acts as the value, creating a key-value store for computation results.

```
// Self-claimed output example: storing game state
Output {
    verifier: { contract: RECORD_CONTRACT, params: encode("state") },
    value: 0,
    data: <game_state_bytes>
}
```

A block can have multiple self-claimed outputs with different keys:

```
Block outputs:
  [0] { verifier: SELF/"state",  value: 0, data: <game_state> }     // self-claimed
  [1] { verifier: SELF/"tick",   value: 0, data: <tick_number> }     // self-claimed
  [2] { verifier: GAME/config,   value: 10, data: <next_request> }   // regular output
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
ref_output_data(ref_index, output_index) → bytes
ref_output_verifier(ref_index, output_index) → (hash, bytes)
```

A contract can iterate a referenced block's outputs, find the one with the expected verifier, and read its data. For example, reading a previous game state:

```
// In game tick contract:
for i in 0..ref_output_count(0) {
    let (contract, params) = ref_output_verifier(0, i);
    if contract == RECORD_CONTRACT && params == "state" {
        let prev_state = ref_output_data(0, i);
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

Adds a self-claimed output with verifier `(RECORD_CONTRACT, key)` and data `value`. In generation mode, creates the output and adds a self-claim. In verification mode, checks that a matching self-claimed output exists with the expected data.

#### Claimed Outputs

```
claimed_output_count() → u32
claimed_output_data(index) → (ptr, len)
claimed_output_verifier(index) → (contract_ptr, contract_len, params_ptr, params_len)
```

Iterate over all outputs being claimed by this block. The contract can read each claimed output's data and verifier to validate the claim.

#### Output Requirements

```
add_output(contract_ptr, contract_len, params_ptr, params_len,
           value, data_ptr, data_len) → void

get_output(contract_ptr, contract_len, params_ptr, params_len)
    → (value, data_ptr, data_len)
```

Both functions append an output to the running contract's namespace slot
(its position in the block's namespace sequence is the order of the calls).
The contract's declared `outputNamespaces` must include the supplied
`contract` hash, or the runtime rejects.

- **`add_output`**: the contract fully specifies `(verifier, value, data)`.
  Generation: creates the output. Verification: matches the next slot's
  output against the contract's spec exactly.
- **`get_output`**: the contract names the verifier only. Generation: the
  host synthesizes `(value, data)` via its registered handler chain (see
  [Host handler registration](#host-handler-registration)) and appends the
  output; the return value is reported back to the contract for use.
  Verification: the host reads the next slot's output from the block and
  returns its `(value, data)` to the contract. The contract's view of gen
  and verify is identical -- both appear as "I asked for an output under
  this verifier, here is what got produced."

`get_output` is the mechanism for values the contract cannot fully
pin down: aggregation incentive amounts set by market dynamics, user input
for multiplayer games, data blobs resolved by hash, oracle fetches.

**Solidification-time value override.** The block-creation layer (not the
contract) may raise the `value` of a `get_output`-produced slot during
solidification, before the block is signed. This is how aggregation
incentives get their final amount without the contract knowing it.
The override may change `value` only; `verifier` and `data` are fixed at
generation time. Verification has no special case -- it reads whatever
value ended up on the wire and hands it to the contract.

<!-- TODO(@joel): consider collapsing add_output and get_output into a single
     request method, e.g.
       request_output(verifier, data?, value?) -> { value, data }
     Semantics would vary by argument count:
       - (verifier, data, value)  -- behaves like today's add_output
       - (verifier, data)         -- contract supplies data; host supplies value
       - (verifier)               -- host supplies both data and value
     An extra twist: value could always be host-raisable beyond the contract's
     declared floor, unifying the solidification override. Deferring for now
     because it complicates the verification-side read path and the two-method
     split reads cleanly in contract code. Revisit once we have more real
     contracts than just aggregation/collateral/signature. -->

#### Host Handler Registration

`get_output` is resolved during generation by a chain of handlers keyed on
the **running contract's hash** (not the requested output's contract). Each
handler is:

```
Handler = (runningParams: Uint8Array, outputVerifier: Verifier)
    → Promise<{ value: Number, data: Uint8Array } | null>
```

Handlers return `null` to defer to the next handler; a non-null result
terminates the chain. The host resolves in this order:

1. **Built-in Scaffold resolvers** -- protocol-aware lookups run first, in a
   fixed order. Examples: blob-registry hash lookup (returns stored data
   when the requested verifier is a hash-lock contract), UTXO lookup,
   aggregation-incentive computation. These compose deterministically from
   block state so honest nodes converge.
2. **Userspace handlers** -- application code registers handlers via the
   node API, keyed by the running contract hash. Handlers run in
   registration order. This is where user-code for interactive games, app
   state contributions, or external data sources plugs in.
3. **No resolver matched** -- generation blocks, with the same
   restart-on-uncanonical lifecycle as `requireInput`. A handler that needs
   to wait for user input, for example, resolves its promise when input
   arrives.

Registration is additive; there is no protocol-level ordering guarantee
between userspace handlers beyond registration order. Handlers are scoped
to a single node's runtime -- they are not part of the protocol and
cannot affect verification.

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
ref_output_data(ref_index, output_index) → (ptr, len)
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

Verification is organized in three layers, each with a single responsibility:

1. **Contract host** (primitive): Given a `{block, verifier}`, load the contract WASM, construct a `VerifyingEnv`, and run it to produce an `ExecutionResult` (`{ accepted: true }` or `{ accepted: false, reason }`). Knows nothing about claims, blocks-under-verification, or scheduling.
2. **Contract verification** (per-verifier dedupe): Memoize `{block, verifier}` → `Promise<ExecutionResult>`. If the same tuple is requested while in-flight, share the in-flight promise; if completed, return the cached result. Result is valid forever — verification is pure over block content. Each request that isn't cached enqueues an `Executable` on the [execution queue](execution-queue.md) with a full per-verifier budget (see [Per-Verifier Budget](#per-verifier-budget)).
3. **Block verification** (per-block orchestration): Given a block hash, enumerate its resolved claims, look up each claimed output's verifier, and dispatch per-verifier verification. All verifiers must accept for the block to be valid (fail-fast on first rejection).

### Per-Claim, Not Per-Contract

Each `{verifier.contract, verifier.params}` combination runs independently. Two claims with the same contract hash but different params are **two separate verifications** — params are inputs that may change the accept/reject decision. An earlier implementation grouped claims by contract hash and ran the contract once with the first claim's params; that is incorrect and has been removed.

### Deferred Verification for Unresolved Claims

A block's `claims: Index[]` are indices into the block's **extended output vector** (own outputs + aggregates' output spaces + anchor's surviving outputs). Resolving a claim index to a concrete `{block, verifier}` requires the ancestor chain (anchor and aggregates) to be loaded locally, per [output claims: migration](output-claims.md#migration). If a claim cannot yet be resolved, block verification **defers** — it registers a one-shot callback on `OutputClaimModule.onResolution` for the claiming block, and re-drives verification when the resolution arrives. Verification is never failed due to unresolved claims; it waits.

### Per-Verifier Budget

The verification budget for a single `{block, verifier}` is derived from the block's total weight and the risk transfer fee, per [execution queue: verification budget](execution-queue.md#verification-budget). Every distinct verifier on a block receives the **full** budget — budgets are not split across N verifiers. Two consequences:

- A block with many verifiers may consume up to N × budget of wall-clock time. This keeps per-verifier decisions independent and maximizes the chance any given rejection catches fraud.
- A cumulative per-block cap is a future concern — when it lands, it will terminate all in-flight verifiers for a block once the block's cumulative budget is exceeded. Tracked in `TODO.md`.

### Contract Semantics

Within a single contract invocation:

1. The host loads the contract WASM identified by the output's `verifier.contract`.
2. The host passes the verifier's `params` via `current_params()`.
3. The contract executes, reading claimed outputs, checking constraints, and validating the block's self-claimed data and outputs.
4. The contract calls `accept()` or `reject()`.

Most simple contracts (signature checks) do not constrain the block's self-claimed outputs — they only check the signature. Complex contracts (game ticks) validate that the self-claimed state is a correct computation given the inputs.

If two claimed outputs' contracts would require different self-claimed data values, they are incompatible and cannot be on the same block — both run, and one will `reject()`.

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

### Layer 2: Two-Tier Collateral

The publisher posts FOR collateral covering two components:

- **Type 1 (Verifier Reward)**: The publisher's stake for short-term validity. Decays back to the publisher over time. Challenged via hash preimage requests (AGAINST bonds). Self-resolving for structural validity.
- **Type 2 (Rectification Insurance)**: Funded by the aggregation fee. Aggregators cover long-term insurance. If fraud is discovered, pays a finder's reward and restores incorrectly claimed outputs.

The **non-descendant requirement** remains critical: collateral must exist independently of the block it vouches for. This is enforced by the [collateral contract's](contracts.md) spending conditions.

For hard contracts, the publisher **must** post FOR collateral on their own block. Without publisher collateral, other peers have no reason to trust the result — there is no economic consequence for fraud.

### Resolution

For structural validity (hash challenges), resolution is self-resolving: the hash preimage either matches or it doesn't. No voting needed. See [collateral-resolution](collateral-resolution.md) for the contract specification.

For computational validity (WASM re-execution disputes), a separate resolution mechanism may be needed — this is an open design question.

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
let data = claimed_output_data(0);  // or read from self-claimed output
if hash(data) != current_params() {   // params = expected hash H
    reject();
}
accept();
```

**Merkle trees**: Combine hash-lock contracts with a merkle node structure. Each merkle node block self-claims its data and outputs to hash-lock contracts for its children. If any child hash is invalid, the child's funds are not claimable and are forfeit. This constructs a verifiable merkle tree from blocks.

---

## Data Queries via AGAINST Challenges

> Superseded by the challenge mechanism in [collateral-resolution](collateral-resolution.md).

Queries and verification are the same operation. To request data from a block (e.g., a hash preimage, a merkle branch), a peer posts an AGAINST challenge bond targeting the relevant hash. The block creator (or anyone with the data) responds by revealing the preimage and earning the bond.

While an AGAINST challenge exists and is unresolved, the target block's effective weight is reduced. This incentivizes fast responses. The verifier reward decay provides the implicit deadline -- there is no explicit timeout.

This replaces the earlier query/promise design. See [collateral-resolution](collateral-resolution.md) for the full mechanism.

---

## Aggregation Ordering

Aggregation blocks should order their subtrees by downstream weight (heaviest first). This ordering:

1. Provides a canonical ordering within the aggregation tree.
2. Is used by the collateral resolution contract to determine the sequence in which disputes are resolved.
3. Is deterministically verifiable from the subtrees' weight vectors.

This interacts with the existing weight-ratio balancing constraint from [DAG structure](dag.md) — the ordering is within the set of subtrees that already satisfy the weight-ratio constraint.

---

## Observability and Construction

Contracts optionally export functions for generic tools to **read** (inspect) and **write** (construct) `params` and `data` fields without contract-specific code:

```
// Reading: contract walks existing bytes, calling host emit functions
walk_params(params_ptr, params_len) → void
walk_data(data_ptr, data_len) → void

// Writing: contract requests field values from host, serializes to bytes
build_params() → void
build_data() → void
```

The walker emits a tree of typed, annotated values. The builder mirrors this -- it requests values from the host (with the same type annotations), letting the host render appropriate input widgets. Both directions use **value descriptors** carrying a MIME-ish type hierarchy (e.g. `bytes/public_key/ed25519`, `bytes/hash/sha256/scaffold/contract`) that the host matches from most specific to least specific for UI rendering.

The builder uses a **default-then-refine** execution model: the host runs the builder, returns defaults for all fields, records the field tree, and renders a form. When the user edits a field, the host re-runs the builder with updated values, which may produce different fields (conditional branches).

All four exports are optional. See [output data format](output-data.md) for the full specification: value descriptors, type hierarchy, WASM host interface, TypeScript bridge, and examples.

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
1. Reads `state_N` from `ref_output_data(0, state_output_index)`.
2. Reads player moves from `claimed_output_data(...)` (claiming move outputs).
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

### Collateral Resolution (AGAINST Challenge Response)

A peer challenges a hash in a block. Anyone with the preimage responds:

```
Challenge block:
  outputs:
    [0] { CHALLENGE/target_block, bond, encode({ type: 'ref', index: 2 }, challenger_pubkey) }

Response block:
  claims: [<challenge_output>]
  data: encode(preimage)
  outputs:
    [0] { SIGNATURE/responder_pubkey, bond, empty }
```

The challenge contract verifies `hash(preimage) == target_hash`. Self-resolving -- no voting needed.

### Rectification

When a block is proven invalid, a restoration block claims from the aggregator's rectification pot:

```
Restoration block:
  claims: [<rectification_pot_output>]
  refs: [<invalid_block>, <aggregation_tree_root>]
  outputs:
    [0] { SIGNATURE/victim_pubkey, restored_amount, empty }
    [1] { SIGNATURE/finder_pubkey, finder_reward, empty }
    [2] { RECTIFICATION/tree_root, remaining_pot, aggregator_pubkey }
```

The rectification contract verifies the proof chain from the aggregation tree root to the invalid block, checks the restoration amounts, and ensures the finder's reward doesn't exceed `alpha * R`. Restoration blocks use easy-to-verify contracts (signature checks) and don't require collateral. See [collateral-resolution](collateral-resolution.md).

---

## Interaction with Other Modules

| Module | Impact |
|--------|--------|
| [Block Creation](block-creation.md) | `refs` added to block structure. Output gains `verifier` (contract + params) and `data` (payload). Self-claims used for computation results. |
| [Contracts](contracts.md) | Computation contract placeholder replaced by this spec. Standard contracts updated to use verifier/data terminology. New SELF contract for self-claimed outputs. |
| [Consensus](consensus.md) | No change. Consumes weight vectors as before. |
| [Conflict](conflict.md) | No change. Self-claimed outputs follow existing self-claim rules. Refs do not participate in conflict detection. |
| [Trust](trust.md) | Two-tier collateral (Verifier Reward + Rectification). Publisher must post both for hard contracts. |
| [Sampling](sampling.md) | Verification cost varies by contract. Hard contracts are more expensive to sample. Priority formula may factor in verification cost. |
| [Gossip](gossip.md) | Needs extension for contract-hash-based routing: peers advertise which contracts they serve. |
| [Deception](deception.md) | Self-flagging incentive via rectification pot. Verifier reward decay deters data hiding. |

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/ContractEnv.ts`](../../src/core/ContractEnv.ts) | `ContractEnv` interface, `Input` type, `ContractFn`, `ContractRejection`, internal provider interfaces |
| [`src/core/VerifyingEnv.ts`](../../src/core/VerifyingEnv.ts) | `VerifyingEnv` -- verification-mode implementation (synchronous, reads from block) |
| [`src/core/GeneratingEnv.ts`](../../src/core/GeneratingEnv.ts) | `GeneratingEnv` -- generation-mode implementation (possibly async, builds the draft) |
| [`src/core/ContractHost.ts`](../../src/core/ContractHost.ts) | Contract registry and primitive `runVerifying` / `runGenerating` entry points. Layer 1 of the verification flow. |
| [`src/core/ContractVerificationModule.ts`](../../src/core/ContractVerificationModule.ts) | `{block, verifier}` dedupe cache; enqueues `Executable` per miss. Layer 2 of the verification flow. |
| [`src/core/ContractVerificationService.ts`](../../src/core/ContractVerificationService.ts) | Wires `ContractVerificationModule` to `ContractHost`, `ExecutionQueueService`, and `SamplingService` for budget. |
| [`src/core/BlockVerificationModule.ts`](../../src/core/BlockVerificationModule.ts) | Per-block orchestrator: enumerates `resolvedClaims`, dispatches per-verifier verification, fail-fast aggregation, defers on unresolved claims. Layer 3 of the verification flow. |
| [`src/core/BlockVerificationService.ts`](../../src/core/BlockVerificationService.ts) | Wires `BlockVerificationModule` to `ContractVerificationService`, `OutputClaimService` (for claim resolution events), and `BlockStore`. |
| [`src/node/GenerationModule.ts`](../../src/node/GenerationModule.ts) | Per-draft generation lifecycle: priority from canonicality, restart-on-uncanonical, default `collectInputs()` at end. |
| [`src/node/GenerationService.ts`](../../src/node/GenerationService.ts) | Wires `GenerationModule` to `ContractHost`, `ExecutionQueueService`, `ConsensusService`, `UtxoIndex`, `DraftStore`, `OutputClaimService`. |
| [`src/core/Block.ts`](../../src/core/Block.ts) | `RECORD_CONTRACT`, result output helpers, block structure |
| Future: WASM runtime | Contract execution engine with host function bindings |

Historical note: `ContractGenerator`, `ExecutionModule`, and `VerificationModule` predated this split and are removed. The single contract-run primitive now lives in `ContractHost`; scheduling and dedupe moved to the verification modules above; generation orchestration moved to `GenerationModule`.
