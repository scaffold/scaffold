# Exploration 1: The Computation-Oracle Model

## Direction

Every Scaffold computation is modeled as a deterministic WASM execution
that may make "oracle calls" — requests for external data — during
execution. An **oracle log** records these interactions, making the
computation fully reproducible for verification. No block schema changes
are needed; everything lives in contracts.

---

## Core Idea

A block that performs computation publishes a **computation result output**
containing:

```
ComputationResultData {
    program:     Hash           // WASM program executed
    inputHash:   Hash           // hash of input data
    result:      Bytes          // the output
    oracleLog:   OracleEntry[]  // external data used during execution
}

OracleEntry {
    request:  Bytes    // what was requested (hash, path, etc.)
    response: Bytes    // what was returned
}
```

Verification is straightforward: load the program, reconstruct the input,
replay the oracle log, execute, and check that the result matches. The
oracle log makes this **deterministically reproducible** even though the
original execution involved external data.

---

## How It Maps to Each Use Case

### 1. Deterministic Computation (GameState -> GameState)

The simplest case. No oracle calls.

```
Request output:
  contract: COMPUTATION_REQUEST
  data: { program: game-tick.wasm, input: serialized_state }
  value: 10  (bounty)

Response block claims the request, produces:
  contract: COMPUTATION_RESULT
  data: { program: game-tick.wasm, inputHash: H, result: next_state, oracleLog: [] }
  value: 9  (fee to responder)
  + aggregation incentive output (value: 1)
```

Verification: re-execute `game-tick.wasm(state)`, compare to `result`.

Weight: proportional to WASM execution cost.

The deception game works perfectly here. Verification cost equals
computation cost, so verifiers are funded by occasional fraud
catches. MITM attackers must re-execute the full computation to
verify a result they're relaying — they can't cheaply determine
validity, so stealing results carries deception-game risk.

### 2. Data Lookup by Hash

A special case where the "computation" is trivial (hash check).

```
Request output:
  contract: DATA_REQUEST
  data: { hash: H }
  value: 5

Response block:
  contract: DATA_RESULT
  data: { hash: H, payload: the_data }
  value: 5
```

Verification: `hash(payload) == H`. Trivial.

**MITM problem**: Because verification is trivial, a relay can verify
the data, re-publish it as their own, and safely claim the bounty.
The deception game doesn't help here — the relay can cheaply confirm
validity before claiming.

**Two-stage commitment solution** (from the prompt):

```
Stage 1 — Commitment block (no payment required):
  output: { contract: DATA_COMMITMENT, data: {
    commitment: HASH(data || secret),
    secret: secret,
    targetHash: H
  }}

Stage 2 — Challenge/payment (claims the commitment output):
  The requester pays the committer, producing a payment output
  that the committer can claim by revealing the data.

Stage 3 — Reveal (claims the payment output):
  output: { contract: DATA_RESULT, data: { hash: H, payload: data }}
  Verification: hash(data) == H AND HASH(data || secret) == commitment
```

The commitment is published *before* payment. A MITM relay sees
`HASH(data || secret)` and `secret` but doesn't have `data`, so they
can't produce their own commitment. Once the committer reveals the
data in Stage 3, the commitment already establishes priority.

**Alternative: the deception angle.** Even without the commitment
scheme, data providers can occasionally commit to *wrong* data. A
MITM relay that adopts the commitment inherits the fraud risk.
However, this only works if the relay can't verify the data against
the hash — which they can, since the response includes the data.
So the commitment scheme is the more robust solution for data
lookups.

### 3. Structured Data I/O (Filesystem-like)

A computation that consumes and produces structured state (e.g., a
disk image).

This is handled by the **contract-as-explorer** pattern already
designed in output-data.md. The computation's output data is opaque
bytes, but the contract's WASM exports `list()`, `read()`, `type()`
functions that let generic tools walk the data.

```
Compilation block:
  claims: [disk_image_output]
  outputs: [
    { contract: COMPILATION_RESULT,
      data: compiled_disk_image,  // opaque bytes
      value: ... }
  ]

COMPILATION_RESULT contract exports:
  list(data, []) -> ["bin", "lib", "etc", ...]
  read(data, ["bin", "myapp"]) -> <binary contents>
  type(data, ["bin", "myapp"]) -> "bytes"
```

Verification: re-run the compilation. Compare output bytes.

The explorer interface is orthogonal to computation verification —
it's about inspecting the result, not checking correctness. This
means structured data I/O requires no new primitives beyond what
output-data.md already specifies.

### 4. Secret/Offline State (Merkle Trees)

The hardest case. A block stores only a commitment (merkle root) in
its output, and the full state lives with the publisher.

```
Aggregation block with claim mask:
  output: { contract: AGGREGATION, data: {
    claimMask: <merkle_root>,  // only the root is on-chain
    ...
  }}
```

Subtree queries (requesting specific merkle branches) need to go to
the publisher.

**Model**: Oracle calls during computation.

When the aggregation block was created, the WASM program made oracle
calls to read merkle subtrees from its own local state:

```
oracleLog: [
  { request: "merkle_node/0/left", response: <hash> },
  { request: "merkle_node/0/right", response: <hash> },
  ...
]
```

Verification of the *computation* replays these oracle responses
and checks the result. This verifies "given these merkle branches,
was the root computed correctly?" — but NOT "are these merkle
branches the real ones?"

**Oracle verification** is the second layer. For merkle data, the
oracle responses must be consistent with the subtrees that were
aggregated. A verifier who has the subtree blocks can check this.

**Live queries** (after publication) follow the state query pattern:

```
Query block:
  output: { contract: STATE_QUERY, data: {
    target: block_hash,
    path: [3, 0, 1],  // merkle path
    bounty: 2
  }}

Response block (from publisher):
  claims: [query_output]
  output: { contract: STATE_RESPONSE, data: {
    proof: <merkle_proof>,
    data: <leaf_data>
  }}
```

**Validity pressure**: While a state query is pending and unanswered,
it functions as a soft challenge. Aggregators should treat the
targeted block as having elevated risk (the publisher may be
unresponsive or the state may not exist). This doesn't formally
invalidate the block, but it increases the sampling module's
priority for verifying it.

---

## Two Levels of Verification

This model cleanly separates two concerns:

### Level 1: Computation Verification

"Did the WASM program produce the claimed result, given these
inputs and oracle responses?"

- Deterministic: replay with same inputs and oracle log
- Same cost as original execution
- Fits directly into the sampling module
- The deception game incentivizes this verification

### Level 2: Oracle Verification

"Are the oracle responses themselves valid?"

- For hash lookups: `hash(response) == request`. Trivial.
- For merkle proofs: verify proof against committed root. Cheap.
- For arbitrary state: may require fetching external data.

Oracle verification is typically much cheaper than computation
verification. This is important because it means an AGAINST
collateral posting for oracle fraud can be independently verified
without re-executing the full computation.

**Dispute paths** are thus two-dimensional:

```
Fraud type 1: Computation error
  Evidence: re-execution produces different result
  Challenge path: [block, "computation"]

Fraud type 2: Oracle fraud
  Evidence: oracle response doesn't match its verification condition
  Challenge path: [block, "oracle", entry_index]
```

Both use the existing collateral/dispute mechanism from trust.md.

---

## Challenges vs. Queries: Unified Mechanics, Different Semantics

The prompt asks whether to unify challenges and queries. The answer:
**same mechanical primitive, different spending conditions**.

Both are "request output → response block" patterns:

```
Request output → Response block claims it → Result available
```

But the contract semantics differ:

| Property | Challenge | Query |
|----------|-----------|-------|
| Purpose | Prove validity/invalidity | Retrieve data |
| Response mandatory? | Yes — non-response is fraud evidence | No — just unprofitable |
| Affects block validity? | Yes | No |
| Timeout | Configurable; triggers AGAINST evidence | No timeout; bounty eventually expires |
| Spending condition | Must contain valid proof or counter-proof | Must contain requested data |

**Challenges** are formal validity disputes. A challenge to a block's
computation or oracle log creates an obligation: the publisher must
respond with evidence, or the block is treated as fraudulent.

```
ChallengeData {
    target:     Hash       // block being challenged
    path:       Bytes      // what's being challenged (computation, oracle[i])
    evidence:   Bytes      // challenger's claim (e.g., different computation result)
}
```

**Queries** are economic incentives. A query requests data but doesn't
threaten validity. The publisher responds because they earn the bounty.

```
StateQueryData {
    target:     Hash       // block whose state is queried
    path:       Bytes      // what data is requested
}
```

### Should unanswered queries affect validity?

An interesting middle ground: queries don't *formally* affect validity,
but they function as **trust signals** that the sampling and trust
modules can observe. An aggregator seeing many unanswered queries on
a block should increase their probing rate. This creates indirect
pressure without coupling query mechanics to the validity system.

---

## MITM Protection Analysis

The deception game's effectiveness depends on verification cost:

| Computation Type | Verification Cost | Deception Game Effective? | MITM Protection |
|-----------------|-------------------|--------------------------|-----------------|
| Heavy computation | High (re-execution) | Yes | Strong — MITM can't cheaply verify |
| Hash lookup | Trivial | No | Need commitment scheme |
| Merkle proof | Cheap | Marginal | Medium — proof verification is cheap |
| Mixed (compute + oracle) | Medium-high | Mostly yes | Strong for compute part |

**Key insight**: MITM protection scales with verification cost. For
cheap-to-verify computations, we need the commitment scheme. For
expensive computations, the deception game provides natural MITM
resistance.

---

## The Verification Game in Detail

Integrating the deception equilibrium from deception.md with the
computation-oracle model:

### Publisher Strategy

A publisher occasionally publishes blocks with intentionally wrong
computation results. The oracle log is valid (so oracle verification
passes), but the computation result doesn't match re-execution.

This is optimal because:
1. The block looks structurally correct to anyone who doesn't re-execute
2. Re-execution is expensive (same cost as original computation)
3. If aggregated without verification, the publisher can contest

### Verifier Strategy

Verifiers sample blocks according to the sampling module's priority.
For each sample:
1. Fetch the computation result output
2. Reconstruct inputs from inputHash
3. Replay the oracle log
4. Execute the WASM program
5. Compare result

If mismatch → post AGAINST collateral, citing `[block, "computation"]`.

### Aggregator Strategy

Before aggregating, the aggregator probes subtrees:
1. For each subtree block with computation results, decide whether to verify
2. Re-execute a fraction of computations based on fraud rate estimates
3. Also check oracle log validity (cheap)
4. If satisfied, aggregate and stake collateral

The probe depth calibrates to the fraud rate, as described in deception.md.

---

## Development Experience

### For a game developer (deterministic computation):

```
// Define the game
const gameContract = scaffold.defineComputation({
    program: 'game-tick.wasm',
    weight: (input, output) => GAME_TICK_WEIGHT,
});

// Request a game tick (client side)
const request = gameContract.request(currentState, { bounty: 10 });

// Compute and respond (responder side)
const result = gameContract.execute(requestedInput);
const response = gameContract.respond(request, result);
```

The framework handles:
- Packaging the computation result with oracle log
- Setting up the computation contract output
- Explorer functions for the game state (if defined)

### For a data provider:

```
const dataService = scaffold.defineDataService({
    commitmentScheme: true,  // two-stage commitment for MITM protection
});

// Publish data availability
const commitment = dataService.commit(myData);

// Respond to requests
dataService.onQuery((hash) => {
    return myDataStore.get(hash);
});
```

### For a stateful computation (merkle state):

```
const merkleComputation = scaffold.defineStatefulComputation({
    program: 'merkle-aggregator.wasm',
    stateType: 'merkle',
    queryHandler: (root, path) => getMerkleProof(root, path),
});

// The framework automatically:
// - Records oracle calls to the merkle tree during execution
// - Publishes the merkle root as the commitment
// - Handles state queries by delegating to queryHandler
// - Makes query responses verifiable via merkle proofs
```

---

## Block Schema Implications

**No changes to the block schema.** This is a key advantage.

Everything is expressed through standard contracts:

| Contract | Purpose | Data |
|----------|---------|------|
| COMPUTATION_REQUEST | Bounty for computing | program, input |
| COMPUTATION_RESULT | Published result | program, inputHash, result, oracleLog |
| DATA_REQUEST | Bounty for data by hash | hash |
| DATA_COMMITMENT | Priority commitment | commitment, secret, targetHash |
| DATA_RESULT | Revealed data | hash, payload |
| STATE_QUERY | Bounty for offline state | target, path |
| STATE_RESPONSE | Response with proof | query, proof, data |
| CHALLENGE | Formal validity dispute | target, path, evidence |

The existing `Output { contract, value, data }` structure carries
everything. Contract WASM verifies spending conditions. The sampling
module verifies computation results through re-execution.

### Weight Derivation

For computation blocks, weight maps naturally to Option A or D
from weight.md:

- **Option A**: The computation contract includes a weight function
  based on program + input size. `game-tick.wasm` always costs
  GAME_TICK_WEIGHT.
- **Option D (hybrid)**: Economic throughput (bounty value) provides
  the unfakeable base. The computation supplement is bounded by
  `K * bounty_value`.

The oracle log entries do NOT add weight — they represent data
fetching, not computation.

---

## Open Questions

1. **Oracle log size**: For computations that make many oracle calls
   (e.g., reading a large merkle tree), the oracle log could be large.
   Should the log itself be committed as a merkle root, with individual
   entries fetchable on demand? This adds complexity but keeps block
   size bounded.

2. **Oracle response validation scope**: When a verifier checks a
   computation, should they also check all oracle responses? For merkle
   proofs this is cheap, but for arbitrary oracle types it might not be.
   Separating compute verification from oracle verification allows them
   to be challenged independently.

3. **Computation request matching**: How does a responder find
   computation requests? The gossip module routes blocks by interest,
   but there's no explicit "I can run game-tick.wasm" subscription.
   This may need gossip module extensions or a separate discovery
   layer.

4. **Partial computation**: Can a computation be split across multiple
   blocks? E.g., a long-running simulation broken into chunks. This
   would require the oracle log to reference intermediate results from
   other blocks, creating a computation DAG within the block DAG.

5. **Oracle trust**: Who provides oracle responses, and why should we
   trust them? For hash lookups, the response is self-verifying. For
   merkle proofs, verification is against a committed root. For
   arbitrary data, there may be no way to verify the response
   independently — the oracle call essentially trusts the data source.

6. **Commitment scheme economics**: The two-stage commitment scheme
   requires multiple blocks and rounds of interaction. For small data
   lookups, the overhead may exceed the value. Is there a minimum
   bounty below which the commitment scheme should be skipped?

---

## Comparison with Other Approaches

### vs. "Each block defines its own verification" (Option 1 from prompt)

The computation-oracle model is more constrained: verification is
always "re-execute WASM with same inputs and oracle responses." This
is less flexible (can't define arbitrary verification logic per block)
but more trustworthy — the verification logic is fixed and well-understood,
not defined by the block being verified.

### vs. "Commitment-based with collateral voting" (Option 2 / legacy2)

The legacy2 approach encodes complex voting hierarchies within
collateral resolution. The computation-oracle model is simpler:
verification is binary (computation matches or doesn't), and the
existing collateral/dispute mechanism from trust.md handles the
economics. No new voting primitives needed.

### vs. "Query-based with local/remote distinction" (Option 3 from prompt)

The computation-oracle model IS a refinement of Option 3. Oracle
calls during WASM execution are the "request data" host calls from
Option 3. The key addition is the oracle *log* — recording the calls
makes the computation reproducibly verifiable.

---

## Summary

The computation-oracle model offers:
1. **No schema changes** — everything is contracts
2. **Reproducible verification** — oracle logs make interactive computations deterministic
3. **Clean separation** — compute verification vs oracle verification
4. **Natural deception game integration** — same as existing design
5. **Flexible enough** for all use cases (game state, data lookup, structured I/O, merkle state)
6. **Two-stage commitment** for MITM-resistant data provision

The main risk is complexity in the oracle layer — the oracle log concept
is novel and the interaction between oracle verification and computation
verification needs careful specification. But it provides a clean
abstraction boundary that maps well to the existing protocol architecture.
