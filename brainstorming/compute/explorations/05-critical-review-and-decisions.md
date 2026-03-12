# Exploration 5: Critical Review and Decision Points

## Direction

Step back from design and stress-test the E1-E4 synthesis. Identify
the strongest and weakest parts, unresolved decisions, attack vectors,
integration gaps with existing modules, and what to prototype first.

---

## What's Strong

### 1. Program as Contract (E4)

The insight that the computation WASM IS the spending condition is
the design's strongest contribution. It:

- Eliminates an entire category of contracts (no COMPUTATION_REQUEST,
  COMPUTATION_RESULT — just the program itself)
- Creates self-perpetuating computation chains naturally through
  UTXO claims
- Fits the existing architecture perfectly (no schema changes)
- Makes the development experience clean: write compute(), done

### 2. The Deception Game Equilibrium (E2)

The self-correcting equilibrium is mathematically elegant and
addresses a real problem (verification incentive bootstrapping).
The insurance commitment primitive is small and fits naturally
into FOR collateral blocks.

### 3. Challenge ≠ Invalid (E3)

The distinction between "challenged" and "invalid" is a critical
correctness observation. Without it, challenge spam becomes a trivial
DoS vector. The economic pressure model (aggregation reluctance,
sampling priority boost) achieves the prompt's intent without the
vulnerability.

### 4. No Schema Changes

All four explorations independently arrive at the same conclusion:
everything fits in contracts and outputs. This is a strong signal
that the design is compatible with the existing architecture.

---

## What's Weak or Uncertain

### 1. The Oracle Log May Be Unnecessary

E1 introduced the oracle log as a key primitive. E4 carried it
forward as a self-claimed output. But with program-as-contract and
auto-generated verify(), there's a question: **does the oracle log
actually serve a purpose?**

**The case FOR oracle logs:**
When verify() re-executes compute(), any oracle_fetch() calls need
to return the same data as during creation. If the oracle data is
mutable (e.g., a merkle tree that changed), re-fetching live would
give different results. The oracle log captures the snapshot.

**The case AGAINST oracle logs:**
- For immutable oracle data (hash lookups), the log is redundant —
  re-fetching gives the same result
- For mutable data, the question is whether the COMPUTATION should
  be bound to a specific snapshot. If the merkle tree changed, maybe
  the computation SHOULD be re-evaluated against current state
- The oracle log adds significant complexity: storage, merkle
  commitment for large logs, self-claimed outputs, replay semantics

**Possible simplification**: Eliminate the oracle log entirely.
Instead, oracle_fetch() always fetches live during verification.
If the data changed, the verification fails — which means the
computation is "no longer valid" and should be replaced. This is
actually correct behavior: if the inputs changed, the output may
be wrong.

**Counter-argument**: This makes verification non-deterministic.
Two verifiers might get different oracle results and disagree about
validity. The oracle log ensures consensus on verification outcomes.

**Decision needed**: Is the oracle log worth its complexity? Could
we restrict oracle calls to only immutable data (hash lookups) and
handle mutable state through the offline state commitment mechanism
(E3) instead?

### 2. Two-Stage Commitment Is Expensive for Data Lookups

The two-stage commitment scheme requires 3 rounds of interaction:
1. Provider publishes commitment
2. Requester pays
3. Provider reveals data

For a simple "give me the data with hash H" query, this is heavy.
The total cost in blocks and latency may exceed the value of the
data.

**Alternatives**:
- **Accept MITM risk for cheap data**: Data gets delivered regardless
  of who claims the bounty. The "victim" is the original data holder
  who doesn't get paid, but the requester still gets their data.
- **Encrypt the response**: Provider encrypts data with requester's
  public key. MITM gets encrypted blob they can't use. But this
  requires the requester to be online and breaks the open, cacheable
  nature of the data.
- **Reputation-based routing**: Route data requests preferentially
  to the gossip peers most likely to have the data. Reduce MITM
  opportunity through topology rather than cryptography.
- **No bounty for data lookups**: Data provision is altruistic or
  funded indirectly (the data holder benefits from their data being
  available because it supports their other economic activity).

**Decision needed**: Is the two-stage commitment worth implementing
for data lookups, or should we accept MITM risk and simplify?

### 3. Challenge Stake Calibration

E3 says challengers must stake collateral, but doesn't specify how
much. The stake must balance:

- **Too low**: Spam challenges are cheap. Adversaries can impose costs
  on publishers by forcing them to respond to many challenges.
- **Too high**: Legitimate challengers can't afford to challenge.
  Fraud goes undetected because the barrier to challenge is too high.

**Proposed heuristic**: Challenge stake = K × estimated response cost,
where K is a small multiplier (2-5x). The estimated response cost
is contract-specific:
- Merkle proof: O(log N) hashes → low stake
- Full re-execution: computation cost → higher stake

But how does the protocol know the response cost? The contract could
declare it (via a `challenge_cost()` export), or it could be a fixed
protocol parameter.

**Decision needed**: How is the challenge stake determined? Fixed
parameter, contract-declared, or market-driven?

### 4. State Availability After Publisher Disconnects

This is the biggest unresolved problem in E3. If the publisher goes
offline:
- Their offline state becomes inaccessible
- Pending queries go unanswered
- Challenges can't be responded to → block may be treated as fraudulent

**This is actually how it should work.** If you commit to offline
state and then disappear, you've effectively published a block you
can't defend. The collateral consequences are appropriate — you lose
your stake.

But what about legitimate disconnects (temporary network issues)?

**Proposed mitigation**: The challenge deadline should be generous
enough to handle temporary disconnects (hours, not seconds). The
publisher can pre-replicate their offline state to trusted peers
who can respond on their behalf.

**State replication incentive**: The publisher could create
STATE_QUERY outputs targeted at specific peers, paying them to
cache the data. This creates a distributed availability layer
funded by publishers who care about their uptime.

**Decision needed**: Is publisher-funded replication sufficient,
or does the protocol need a mandatory replication mechanism?

### 5. The Insurance Commitment Privacy Problem

E2 identifies that universal insurance requires the commitment to
not leak whether the block is a trap. The commitment is
`HASH(correct_result || secret)`.

**Attack**: If a verifier suspects block H might be a trap, they
compute the correct result R by re-executing. They then try
`HASH(R || S)` for various S values. If they match the insurance
commitment, they know H is honest (the insurance result matches the
claimed result). If they can't match, they know H is a trap.

**Defense**: The secret S must be large enough to prevent brute-force.
If S is 256 bits, this attack is computationally infeasible.

But there's a subtler problem: if the verifier computes R and it
MATCHES the block's claimed result, they know the block is honest
(no need to check insurance). They only need to check insurance when
R DIFFERS from the claimed result — at which point they already know
it's a trap (from the re-execution) and don't need the insurance to
tell them.

**Conclusion**: The insurance privacy problem is actually a non-issue.
By the time a verifier can check the insurance, they've already
re-executed and know the answer. The insurance is only useful to the
publisher for self-catching, not for signaling.

### 6. Weight Derivation for Computation Blocks

Weight.md discusses several options (contract-declared, economic
throughput, hybrid). E4 suggests programs export `weight()`. But this
creates the "easy trick" attack from weight.md:

A computation that's cheap with a shortcut but appears expensive
declares high weight through `weight()`. Verification passes (the
computation is correct), but the weight is inflated.

**With program-as-contract**: The weight function is part of the
contract, so it's at least consistently applied — everyone computing
the same input gets the same weight. But a contract author could
set weight artificially high.

**Mitigation**: Weight could be bounded by economic throughput
(weight.md Option D). `declaredWeight <= K × output_value`. This
caps the consensus influence of any single computation.

**Decision needed**: Should weight be purely contract-declared,
purely economic, or hybrid? This affects whether computation-heavy
but low-value blocks (game ticks) can accumulate meaningful
consensus weight.

---

## Integration with Existing Modules

### Sampling Module

The sampling module selects "units of work" to verify. With the
computation model, a unit of work is a specific computation on a
specific block. Integration points:

**What changes**:
- "Verify a unit of work" now means: find a computation output on
  the block, re-execute the program, compare the result
- The sampling module needs to know which outputs are computation
  results. Convention: any output whose contract exports `compute()`
  is a computation result.

**What stays the same**:
- The Beta distribution model for work authenticity
- The priority formula (expected weight swing × dampening)
- The pessimistic pending model

**New concern**: Verification cost varies dramatically by computation
type. A game tick might take 1ms. A compilation might take 10 seconds.
The sampling module should factor in verification cost when selecting
samples — it's not just about information gain but about ROI.

```
priority(T) = expected_swing(T) × dampening(T) / verification_cost(T)
```

This biases sampling toward cheap-to-verify computations, which
might miss expensive fraudulent ones. Counterbalance: the deception
game naturally makes expensive computations high-value targets for
deception, so publishers are incentivized to set traps there, and
the higher collateral makes catching them worthwhile despite higher
verification cost.

### Gossip Module

**What changes**:
- Blocks should be routed based on computation contract hash, not
  just resource interest. A node running game-tick.wasm wants to
  see GAME_TICK outputs.
- Challenge and query blocks should be routed to the publisher of
  the target block.

**Proposed extension**: Peers advertise computation contract hashes
they serve. The gossip module learns this and routes computation
requests to matching peers. This is analogous to the existing
"what each peer cares about" learning.

### Consensus Module

**No changes needed.** The consensus module consumes weight vectors
and resolves conflicts. It doesn't care how blocks are verified —
it just uses the verified/declared weight ratio from the sampling
module.

### Conflict Module

**No changes needed.** Computation outputs are regular outputs.
Two blocks claiming the same computation request output conflict.
The conflict module handles this normally.

---

## Attack Vectors

### 1. Computation Bomb

An adversary publishes a WASM program that runs forever (infinite
loop). Anyone who tries to verify it gets stuck.

**Defense**: WASM execution must have a gas/instruction limit.
Exceeding the limit = verification failure. The contract's
`weight()` function should correlate with the instruction limit —
higher weight allows more instructions.

```
max_instructions = declaredWeight × INSTRUCTIONS_PER_WEIGHT_UNIT
```

If the computation exceeds this limit, it's treated as invalid.
This also prevents the weight inflation attack — you can't declare
high weight without actually doing the work, because the instruction
limit is enforced.

**Important**: This is a significant constraint. It means
`declaredWeight` isn't just about consensus influence — it also
determines the computation budget. This tightly couples weight to
actual computation, which is actually desirable.

### 2. Oracle Amplification

An adversary creates a computation that makes millions of oracle
calls, bloating the oracle log and increasing verification cost
disproportionately.

**Defense**: Oracle calls should count toward the instruction limit.
Each oracle_fetch costs some number of "gas units." This bounds the
total oracle activity.

### 3. Challenge Griefing

An adversary publishes many challenges against a target block, forcing
the publisher to respond to each one. Even with challenge collateral,
the publisher bears response costs.

**Defense**: Rate limiting on challenges per target. After K pending
challenges on a block, additional challenges are ignored until some
resolve. The first K challengers are the ones with standing.

Also: if all K challenges are defended successfully, the publisher
collects K × challenge_stake in rewards, which may exceed their
response costs.

### 4. Self-Dealing Deception

A publisher acts as both publisher and verifier (different identities).
They publish a trap, then "catch" it themselves from a different
identity, earning the verification reward rather than the jackpot.

**Is this harmful?** No. The collateral still gets redistributed.
The publisher loses their FOR collateral (-1000) and gains the
verification reward (+1000). It's a wash. They can't claim the
jackpot because the "verifier" catches it before the self-catch
deadline.

The deception game's incentives are robust to this: the publisher
earns more by either (a) publishing honestly (+1) or (b) self-catching
after the deadline (+1M). Self-dealing just breaks even.

### 5. Stale State Exploitation

An adversary claims a computation result output with a very old
state, producing a "correct" next state but one that's irrelevant
because the game has moved on.

**Defense**: This is already handled by the conflict module. The old
state output can only be claimed once. Once someone claims it, the
next state output is the new UTXO. The adversary can't claim an
already-claimed output.

### 6. Contract Poisoning

An adversary deploys a malicious contract (WASM) that appears useful
but contains a backdoor — e.g., it declares all outputs as "valid"
regardless of correctness.

**Defense**: Users choose which contracts to interact with. A
malicious contract only affects outputs that reference it. The
protocol doesn't vouch for contract quality — that's a social/market
concern. Tooling (contract auditors, reputation systems) can help
users evaluate contracts.

---

## What to Prototype First

Priority order for implementation:

### Phase 1: Program as Contract

1. Extend the WASM runtime to support the host interface
   (output_data, block_output_data, accept/reject)
2. Implement auto-generated verify() from compute()
3. Build a simple computation contract (counter increment)
4. Test: create output → claim with correct result → verify passes

This validates the core "program as contract" model with minimal
complexity. No oracle logs, no deception game, no offline state.

### Phase 2: Computation Chains

1. Build a game-tick-like contract
2. Test self-perpetuating chains: output → claim → output → claim
3. Test conflict resolution when two responders claim the same output

This validates the UTXO chain model for ongoing computation.

### Phase 3: Deception Game

1. Implement insurance commitments on FOR collateral blocks
2. Implement self-catch verification
3. Test the equilibrium: publish traps, verify, self-catch
4. Measure the actual fraud/catch rates

### Phase 4: Offline State

1. Implement COMMITTED_STATE outputs with merkle root
2. Implement STATE_QUERY and STATE_CHALLENGE contracts
3. Test challenge-response flow
4. Test aggregation with offline state blocks

### Phase 5: Oracle Calls (If Needed)

1. Implement oracle_fetch host function
2. Implement oracle log recording and replay
3. Test computation with oracle calls
4. Decide based on real usage whether oracle logs are worth the
   complexity

---

## Key Decisions Summary

| # | Decision | Options | Recommendation |
|---|----------|---------|----------------|
| 1 | Oracle log | Keep (E1) vs. eliminate and use live re-fetch | Defer to Phase 5. Prototype without oracle logs first. Add only if real use cases need mutable oracle data. |
| 2 | Data lookup MITM | Two-stage commitment vs. accept MITM risk | Accept MITM risk initially. Data still gets delivered. Add commitment scheme only if MITM becomes a real problem. |
| 3 | Challenge stake | Fixed vs. contract-declared vs. market | Contract-declared via `challenge_cost()` export. Fallback to a fixed minimum if not exported. |
| 4 | State availability | Publisher-funded replication vs. mandatory | Publisher-funded. Let the market decide availability levels. |
| 5 | Weight derivation | Contract-declared vs. economic vs. hybrid | Instruction-limited (gas). declaredWeight determines gas budget. Weight = actual computation cost. |
| 6 | Insurance privacy | Large random secret vs. alternative scheme | 256-bit random secret. Privacy is a non-issue per the analysis above. |
| 7 | Gossip routing for computation | Extend gossip vs. separate discovery | Extend gossip module with contract-hash-based routing. |

---

## Comparison with E1-E4

This exploration doesn't propose a new model — it evaluates the
existing synthesis. Key outcomes:

- **Oracle logs downgraded** from "key primitive" (E1) to "optional
  complexity to add later if needed." Most use cases work without
  them.
- **Two-stage commitment downgraded** from "necessary for MITM
  protection" to "nice-to-have." Data delivery is the primary goal;
  attribution is secondary.
- **Gas/instruction limits elevated** to a critical concern. Without
  them, computation bombs are trivial. With them, declaredWeight
  becomes meaningful (it determines the computation budget).
- **Phase ordering identified**: program-as-contract → chains →
  deception → offline state → oracle calls. Each phase is
  independently valuable and testable.

---

## Summary

The E1-E4 synthesis is strong. The core design (program-as-contract,
deception game, challenges ≠ invalid) is sound. The main adjustments
from this review:

1. **Simplify first**: Prototype without oracle logs or two-stage
   commitments. Add complexity only when real use cases demand it.
2. **Gas limits are critical**: declaredWeight should directly
   determine the WASM instruction budget, preventing computation
   bombs and making weight meaningful.
3. **The insurance privacy concern is a non-issue**: by the time you
   can check the insurance, you've already re-executed and know the
   answer.
4. **State availability is the publisher's responsibility**: the
   protocol shouldn't mandate replication, but should make it easy
   to fund.
5. **Prototype in phases**: each phase is independently valuable and
   validates a specific part of the design before adding the next
   layer.
