# Exploration 3: Offline State, Challenges, and the Validity Lifecycle

## Direction

Deep-dive into secret/offline state as a protocol-level concern. A block
stores only a commitment (merkle root, hash) and the actual data lives
with the publisher. This exploration designs the challenge-response
mechanism, the block validity lifecycle, and resolves the question of
whether challenges and queries should be unified.

---

## The Core Problem

Offline state creates a fundamental tension: **the block is on-chain
but its data is not**. Anyone can publish a commitment to state that
doesn't exist. The protocol needs a way to:

1. Allow peers to request offline data
2. Create economic pressure for publishers to respond
3. Detect and penalize publishers who committed to nonexistent state
4. Not allow adversaries to cheaply paralyze blocks via challenge spam

---

## Challenge vs. Query: They Are Different Primitives

Exploration 1 argued "same mechanics, different semantics." After deeper
analysis, I think they should be **separate primitives** with different
rules, because they differ in three fundamental ways:

### Dimension 1: Adversarial vs. Cooperative

**Challenges** are adversarial. The challenger believes the block is
invalid and stakes collateral to prove it. If the challenge is resolved
in the publisher's favor, the challenger loses their stake. Challenges
are zero-sum.

**Queries** are cooperative. The querier wants data and offers a bounty.
The publisher responds to earn the bounty. If the publisher doesn't
respond, the querier loses the bounty but nothing else happens. Queries
are positive-sum.

### Dimension 2: Affects Validity vs. Affects Nothing

**Challenges** affect the block's validity status. A pending challenge
signals elevated risk. A resolved-invalid challenge proves fraud.

**Queries** don't affect validity at all. An unanswered query is just
an unfilled request. The data exists (or doesn't), but the query itself
carries no validity implication.

### Dimension 3: Fixed vs. Extensible

**Challenges** target specific, immutable aspects of the block (is this
merkle path correct? is this computation result correct?). The challenge
interface is fixed by the block's contract.

**Queries** are extensible. New deserializers, formatters, or
transformations can be defined after the block is published. The query
interface can evolve.

### The Escalation Path

A query CAN escalate to a challenge:

```
1. Querier requests data at path [3, 0, 1]
2. Publisher responds with data + merkle proof
3. Querier verifies proof against committed root
4. If proof is invalid → querier posts a CHALLENGE with the bad proof
   as evidence
5. Challenge enters the dispute mechanism
```

This gives a natural lifecycle: queries are the default cooperative
interaction, and challenges are the escalation when something is wrong.

---

## The Validity Lifecycle

A block's validity is NOT binary. It evolves through states:

### Block Validity States

```
PRESUMED_VALID   Block is published, no challenges.
                 Other peers can build on it with normal risk.

CHALLENGED       One or more challenges are pending.
                 Elevated risk. Cautious peers avoid building on it.
                 Aggregators increase probing or wait.

DEFENDED         Publisher responded to all challenges successfully.
                 Returns to PRESUMED_VALID with stronger trust signal.

FRAUDULENT       A challenge was resolved against the publisher.
                 Permanent. Block is invalid. Collateral is claimable.
```

### Key Design Decision: Challenged ≠ Invalid

The prompt says "while a query is pending, the block is considered
invalid." I believe this should be softened:

**A challenged block is UNVERIFIED, not invalid.**

Why? If pending = invalid, then challenge spam is a trivial DoS attack:
publish a cheap challenge to make any block "invalid" and prevent anyone
from building on it.

Instead, "challenged" means:
- Aggregators should treat the block as higher risk
- The sampling module should increase verification priority
- Peers CAN still build on it (at their own risk)
- The block's verified weight in consensus may be discounted

The economic effect is the same as the prompt's intent — peers won't
WANT to build on challenged blocks — but it's an economic choice, not
a structural prohibition.

### Anti-Spam: Challenges Must Be Staked

Every challenge requires collateral from the challenger:

```
Challenge output:
  contract: STATE_CHALLENGE
  value: min_challenge_stake  // challenger's collateral
  data: {
    target:    Hash     // block being challenged
    path:      Bytes    // specific aspect challenged
    evidence:  Bytes    // why the challenger believes it's invalid
  }
```

If the publisher responds correctly (merkle proof checks out):
- Challenger's collateral goes to the publisher
- Challenge is resolved as DEFENDED

If the publisher doesn't respond within the deadline:
- Challenge is treated as evidence of fraud
- Publisher's collateral is at risk

If the publisher's response is invalid:
- Challenge is resolved as FRAUDULENT
- Publisher's collateral goes to the challenger

The stake makes challenges expensive, preventing spam while still
allowing legitimate disputes.

### Challenge Deadlines

Each challenge has a deadline measured in anchor chain depth:

```
challenge_deadline = challenge_block.anchor_depth + RESPONSE_WINDOW
```

RESPONSE_WINDOW is a protocol parameter. It must be:
- Long enough for the publisher to see the challenge and respond
  (accounting for gossip delays)
- Short enough that the block's validity is resolved before
  aggregation pressure mounts

Suggested: 5-10 anchor chain depths. For a network producing one
chain link every ~30 seconds, this is 2.5-5 minutes.

---

## Offline State Commitments

### The Commitment Output

A block that commits to offline state produces an output:

```
Output {
    contract: COMMITTED_STATE
    value: 0
    data: {
        root:       Hash      // merkle root (or other commitment)
        schema:     Hash      // WASM program that validates proofs
        stateType:  String    // "merkle" | "blob" | custom
    }
}
```

The `schema` WASM program exports:

```
// Validate a proof against the commitment
validate(root: bytes, path: bytes, proof: bytes) -> bool

// Explorer functions (from output-data.md)
list(root: bytes, path: bytes, proof: bytes) -> [keys]
read(root: bytes, path: bytes, proof: bytes) -> bytes
type(root: bytes, path: bytes, proof: bytes) -> type_tag
```

Note that the explorer functions now take a `proof` argument — they
can't read the data without the publisher providing it. This is the
key difference from inline data: for inline data, the explorer functions
read directly from the output's `data` field. For offline state, they
need an additional proof parameter.

### Merkle Trees as the Standard Case

For merkle-committed state (the most common case):

```
Commitment: merkle root hash
Proof: merkle proof (list of sibling hashes from leaf to root)
Validation: reconstruct root from leaf + proof, compare to commitment
```

This is well-understood and has O(log N) proof size. The schema WASM
for merkle validation is a standard library — most offline state will
use the same schema.

### Other Commitment Types

The model is flexible enough for non-merkle commitments:

- **Blob hash**: commitment = hash(data). Proof = the entire data.
  Validation = hash(proof) == commitment. Simple but requires
  transferring all data.

- **Polynomial commitment**: commitment = polynomial evaluation.
  Proof = evaluation proof at a point. Validation = pairing check.
  More exotic but enables efficient random-access proofs.

The schema WASM abstracts over the commitment type. The protocol
doesn't need to know or care which commitment scheme is used.

---

## Challenge-Response Flows

### Flow 1: Successful Verification

```
1. Publisher creates block H with offline state commitment
     output: { contract: COMMITTED_STATE, data: { root: R } }

2. Publisher creates FOR collateral on H
     output: { contract: COLLATERAL, value: 1000,
               data: { target: H, side: "for" } }

3. Verifier wants to check path [3, 0, 1]
   Verifier creates challenge block:
     claims: []  (no claims needed)
     output: { contract: STATE_CHALLENGE, value: 50,
               data: { target: H, path: [3, 0, 1] } }

4. Publisher responds:
     claims: [challenge_output]  // claims the challenge
     output: { contract: STATE_RESPONSE, value: 50,
               data: { proof: <merkle_proof>, leaf: <data> } }

5. STATE_CHALLENGE contract verifies:
   - Response block claims this challenge
   - schema.validate(R, [3, 0, 1], proof) == true
   - If valid: challenge collateral (50) goes to publisher

6. Block H returns to PRESUMED_VALID (or DEFENDED)
```

### Flow 2: Caught Fraud

```
Steps 1-3: same as above

4. Publisher responds with invalid proof:
     claims: [challenge_output]
     output: { contract: STATE_RESPONSE, value: 50,
               data: { proof: <bad_proof>, leaf: <wrong_data> } }

5. STATE_CHALLENGE contract verifies:
   - schema.validate(R, [3, 0, 1], proof) == false
   - Challenge resolved as FRAUDULENT
   - Challenge collateral (50) returned to challenger
   - Challenger can now claim publisher's FOR collateral
     through the trust module's dispute mechanism
```

### Flow 3: No Response

```
Steps 1-3: same as above

4. Deadline passes. Publisher doesn't respond.

5. No-response is treated as challenge won:
   - Same as if the challenge was resolved FRAUDULENT
   - Challenger claims the challenge collateral back (50)
   - Challenger can claim publisher's FOR collateral
```

### Flow 4: Query (Non-Adversarial)

```
1. Block H exists with offline state commitment

2. Querier wants data at path [users, alice, balance]:
     output: { contract: STATE_QUERY, value: 5,
               data: { target: H, path: [users, alice, balance] } }

3. Publisher responds:
     claims: [query_output]
     output: { contract: STATE_RESPONSE, value: 5,
               data: { proof: <merkle_proof>, leaf: <balance_data> } }

4. Querier verifies locally:
   - schema.validate(R, path, proof) == true
   - Accepts the data

5. If verification fails, querier can escalate to a challenge
   (step 3 of Flow 1)
```

---

## Offline State and the Deception Game

### Can Publishers Trap with Offline State?

Yes. A publisher commits to a merkle root that doesn't match the
actual state (or state that doesn't exist at all).

```
Honest block: root = merkle_root(actual_data)
Trap block:   root = merkle_root(fake_data) or random hash
```

The publisher publishes insurance (from Exploration 2):
```
Insurance commitment = HASH(real_root || secret)
```

If nobody challenges the merkle root (by requesting a path and
discovering the proof doesn't work), the publisher self-catches and
claims the aggregator's collateral.

### Verification Cost for Offline State

To catch offline state fraud, a verifier must:
1. Choose a path to challenge
2. Stake challenge collateral
3. Wait for the publisher to respond
4. Verify the proof

This is fundamentally different from computation verification:
- **Computation verification**: verifier re-executes locally, no
  interaction with publisher needed.
- **Offline state verification**: verifier MUST interact with
  publisher (to get the proof). This makes verification slower and
  more expensive.

The interactive nature means:
- The deception game equilibrium has different parameters for
  offline state (higher V due to interaction cost)
- The fraud rate for offline state may differ from computation fraud
- MITM protection for offline state is weaker (proof verification
  is cheap once you have the proof)

### Challenge Sampling

The sampling module should be extended to sample offline state:

```
For each block with COMMITTED_STATE outputs:
  priority = state_challenge_priority(block)
  If selected: pick a random path, publish a challenge

state_challenge_priority factors:
  - How much weight is built on this block
  - Whether it's been challenged before
  - How much collateral is at stake
  - The general fraud rate for this commitment type
```

---

## Aggregation and Offline State

### The Aggregator's Dilemma

An aggregator considering a block with offline state must decide:
should I verify the state before aggregating?

```
Aggregation expected value:
  EV = fees - P(fraud) * aggregator_collateral
  P(fraud) depends on whether the state has been verified
```

If the block has been challenged and defended → P(fraud) is low.
If the block is unchallenged → P(fraud) is unknown.
If the block has pending challenges → don't aggregate.

### State Probing

Before aggregating, aggregators should probe offline state:

```
1. Select random paths in the committed state
2. Publish challenges (staked)
3. Wait for responses
4. Verify proofs
5. If all pass → aggregate with bounded risk
6. If any fail → don't aggregate, claim fraud
```

The number of probes determines the statistical bound on fraud:
- K probes, all pass → P(fraud) < 1/(K+1) approximately
- With enough probes, the aggregator can bound expected loss below fees

### Aggregation of Offline State

When aggregating a block with offline state, the aggregator has
choices:

**Option A: Carry the commitment forward**
The aggregation block includes the same commitment in its own outputs.
The offline state is still stored by the original publisher. Queries
still go to the original publisher.

```
Aggregation output:
  contract: COMMITTED_STATE
  data: { root: R, schema: S, origin: original_block_hash }
```

**Option B: Absorb the offline state**
The aggregator downloads all the offline state, verifies it, and
re-commits with their own commitment. Queries now go to the aggregator.

This is more expensive but transfers the state custody from the
original publisher to the aggregator. It makes sense for important
state that needs long-term availability.

**Option C: Inline the state**
If the offline state is small enough, the aggregator includes it
directly in an inline output (no commitment needed). This converts
offline state to inline state.

**Recommendation**: Option A by default (cheapest), with Option B/C
for high-value or high-query-frequency state.

---

## Implications for the "Block is Invalid While Pending" Claim

The prompt says blocks should be considered invalid while challenges
are pending. Here's my refined position:

### What Should Be True

1. **Pending challenges increase risk perception.** Aggregators and
   peers should treat challenged blocks with caution. This is an
   economic signal, not a structural rule.

2. **The consensus module should discount challenged blocks.**
   The sampling module already discounts unverified blocks (verified
   weight < declared weight). Pending challenges should increase the
   pessimism — perhaps by adding to the failure count:

   ```
   For each pending challenge on block H:
     sampling_state.failures += challenge_weight_factor
   ```

   This reduces H's verified weight, making it less likely to win
   consensus conflicts and less attractive for building on.

3. **Aggregators should not aggregate blocks with pending challenges.**
   This is a rational economic choice, not a protocol rule. But the
   trust module could make it structural:

   ```
   Aggregation contract verification:
     For each subtree S being aggregated:
       If S has pending STATE_CHALLENGEs → reject aggregation
   ```

   This ensures the aggregator has resolved all doubts before
   committing.

### What Should NOT Be True

1. **Challenged ≠ Invalid.** A pending challenge doesn't prove
   invalidity. It creates a question that must be answered.

2. **Claims on challenged blocks should still work.** If Alice's
   block consumes an output from challenged block H, her block is
   at risk (if H turns out invalid, her claim is invalid). But the
   protocol doesn't prevent her from making this choice — she's
   accepting the risk.

3. **Challenges should not freeze the block graph.** If pending
   challenges made blocks structurally invalid, an adversary could
   cheaply freeze any part of the graph by spamming challenges.
   The staking requirement limits this, but doesn't eliminate it
   entirely.

---

## The Combined Model

Bringing together all three explorations:

### Block with Computation AND Offline State

A block might have both a computation result and offline state:

```
Block H:
  claims: [input_state_output]
  outputs: [
    { contract: COMPUTATION_RESULT,
      data: { program: P, inputHash: I, result: R, oracleLog: [...] } },
    { contract: COMMITTED_STATE,
      data: { root: merkle_root, schema: merkle_validator } },
    { contract: AGGREGATION_INCENTIVE, value: 1 }
  ]
```

This block:
1. Ran computation P on input I, producing result R (Exploration 1)
2. Committed to offline state with merkle root (this exploration)
3. May be a deception trap with insurance (Exploration 2)

Verification has three independent paths:
1. **Computation**: re-execute P with inputs and oracle log → check R
2. **Oracle data**: verify oracle log entries independently
3. **Offline state**: challenge merkle paths → verify proofs

Each can be challenged independently through the dispute mechanism.

### The Full Contract Set

```
Computation layer (Exploration 1):
  COMPUTATION_REQUEST   - bounty for computing
  COMPUTATION_RESULT    - published result with oracle log

Deception layer (Exploration 2):
  DECEPTION_INSURANCE   - commitment to correct result (on FOR block)
  COLLATERAL (existing) - FOR/AGAINST on block validity

Offline state layer (this exploration):
  COMMITTED_STATE       - commitment to offline data
  STATE_CHALLENGE       - staked challenge requesting proof
  STATE_RESPONSE        - publisher's proof response
  STATE_QUERY           - non-adversarial data request

Data lookup layer (Exploration 1):
  DATA_REQUEST          - bounty for data by hash
  DATA_COMMITMENT       - priority commitment (two-stage)
  DATA_RESULT           - revealed data
```

All use the existing `Output { contract, value, data }` structure.
No block schema changes.

---

## Development Experience

### Publishing State

```typescript
// Compute game state and commit it
const newState = computeGameTick(previousState);
const stateTree = buildMerkleTree(newState);

const block = scaffold.publishWithState({
    program: 'game-tick.wasm',
    input: previousState,
    result: serializeCompact(newState),  // compact inline result
    offlineState: {
        type: 'merkle',
        root: stateTree.root,
        provider: (path) => stateTree.getProof(path),
    },
    collateral: 1000,
});

// The framework:
// 1. Creates computation result output
// 2. Creates committed state output with merkle root
// 3. Creates FOR collateral with insurance commitment
// 4. Registers query/challenge handler for offline state
// 5. Automatically responds to challenges with proofs
```

### Querying State

```typescript
// Get a player's position from a game state block
const position = await scaffold.queryState({
    target: gameStateBlock.hash,
    path: ['players', playerId, 'position'],
    bounty: 1,
});

// The framework:
// 1. Publishes STATE_QUERY output
// 2. Waits for STATE_RESPONSE
// 3. Verifies merkle proof locally
// 4. Deserializes and returns the data
// If verification fails, automatically escalates to STATE_CHALLENGE
```

### Challenging State

```typescript
// For verifiers: challenge a random path
const result = await scaffold.challengeState({
    target: suspiciousBlock.hash,
    path: randomMerklePath(),
    stake: 50,
});

// result: { valid: true/false, proof: ..., data: ... }
// If invalid: framework automatically posts AGAINST collateral
```

---

## Open Questions

1. **Nested offline state**: A block commits to state that itself
   contains commitments (e.g., a merkle tree whose leaves are hashes
   of sub-trees). How deep can nesting go? Each level adds interaction
   cost for verification.

2. **State availability after publisher goes offline**: If the publisher
   disconnects, their offline state becomes inaccessible. Should the
   protocol incentivize state replication? Could queries be answered
   by any peer who has a copy?

3. **Proof size vs. state size**: For large state trees, merkle proofs
   can be significant. Is there a point where inline state becomes
   more efficient than offline + proofs?

4. **Challenge coordination**: Multiple verifiers might challenge the
   same path simultaneously. Should duplicate challenges be prevented?
   Or is it fine to let the market sort it out (first responder wins)?

5. **Granularity of fraud**: If one merkle path is fraudulent, is the
   entire block invalid? Or just the specific leaf? This affects the
   dispute module's claiming limits.

6. **State migration during aggregation**: When an aggregator absorbs
   offline state (Option B), how is custody transferred? Does the
   aggregator need to download everything, or can it verify incrementally?

---

## Comparison with Other Explorations

### vs. Exploration 1 (Computation-Oracle Model)

Exploration 1 treated offline state as a variant of oracle calls —
the WASM program makes oracle requests that are logged and replayed.
This exploration goes deeper:

- **Separate primitive**: offline state commitments are distinct from
  computation results. They have their own lifecycle (challenge/defend)
  and their own verification path.
- **Interactive verification**: unlike computation verification
  (re-execute locally), offline state verification requires interacting
  with the publisher. This changes the game theory.
- **Challenge as a first-class concept**: not just an annotation on
  collateral, but a separate contract type with its own spending
  conditions and deadlines.

### vs. Exploration 2 (Self-Catching Deception Game)

The deception game applies to offline state but with different
parameters. Key differences:

- **Verification cost is dominated by interaction**, not computation.
  The equilibrium fraud rate depends on how quickly challenges can be
  published and responded to, not on WASM execution time.
- **Self-catching offline state fraud** works the same way (insurance
  commitment on the correct merkle root), but the "catch window" is
  different — it depends on whether anyone challenges the right path.
- **MITM protection for offline state** is weaker than for computation
  because merkle proof verification is cheap.

### vs. Legacy2 Collateral Voting

Legacy2 used a complex multi-phase voting system for resolving
disputes. This exploration uses a simpler model:

- **Challenge-response** is binary: the proof either validates or
  it doesn't. No need for 7 vote types.
- **Collateral is staked by both sides**: challenger stakes to prevent
  spam; publisher's existing FOR collateral is at risk.
- **Disputes resolve deterministically**: run the schema's `validate()`
  function on the proof. No voting needed.

---

## Summary

Offline state requires:

1. **Commitment outputs** — blocks publish merkle roots (or other
   commitments) with a schema WASM for validation.

2. **Challenges (adversarial, staked)** — verifiers stake collateral to
   demand proof of specific paths. Non-response or invalid response =
   fraud evidence. Distinct from queries.

3. **Queries (cooperative, bountied)** — peers request data and pay
   bounties. No validity impact. Can escalate to challenges.

4. **Validity lifecycle** — blocks are PRESUMED_VALID → CHALLENGED →
   DEFENDED or FRAUDULENT. Challenged blocks have elevated risk but
   are not invalid. Aggregators should not aggregate blocks with
   pending challenges.

5. **Anti-spam** — challenge collateral prevents frivolous disputes.
   Challengers lose their stake if the publisher responds correctly.

6. **No schema changes** — everything fits in contracts and outputs.

The key insight: **challenged ≠ invalid**. Pending challenges create
economic pressure (reduced trust, increased sampling priority,
aggregation reluctance) without structural prohibition. This prevents
challenge spam from being a DoS vector while still achieving the
prompt's goal of making peers reluctant to build on unverified
offline state.
