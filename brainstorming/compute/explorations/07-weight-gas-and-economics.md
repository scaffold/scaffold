# Exploration 7: Weight, Gas, and the Economics of Computation

## Direction

E5 identified gas/instruction limits as "critical" and proposed that
`declaredWeight` directly determines the WASM instruction budget. This
exploration works through what that actually means: how gas, weight,
collateral, bounties, and verification costs interact to create a
coherent economic model for computation blocks. Weight.md identifies
the open question but doesn't resolve it. This exploration attempts to.

---

## The Core Tension

Weight serves two purposes that pull in opposite directions:

1. **Consensus influence**: Higher weight = more consensus power. Blocks
   with more weight are more likely to become canonical and harder to
   dislodge.

2. **Computation budget**: If weight = gas budget, then higher weight =
   more instructions allowed. This prevents computation bombs and makes
   weight meaningful.

The tension: a game tick that computes the next frame of a simple game
might need 10M WASM instructions but has minimal economic value. If
weight comes from economic throughput (weight.md Option B), the game
tick gets negligible weight and negligible computation budget — it can't
even run. If weight comes from declared computation (Option A), the game
tick gets appropriate weight for its work but gains disproportionate
consensus influence relative to its economic importance.

### Why This Matters

If we can't resolve this tension, we have two bad outcomes:

- **Weight = economic only**: Computation-heavy but low-value activity
  (games, simulations, data processing) can't exist on the network.
  The computation budget is too small.

- **Weight = computation only**: Cheap-to-compute but high-value blocks
  (economic transfers) have negligible weight. An attacker running cheap
  computations can outweigh real economic activity in consensus.

---

## Separating Computation Budget from Consensus Weight

The key insight: **weight and gas budget don't need to be the same
number.** They can be *derived from the same declaration* but serve
different purposes with different scaling.

### Proposal: Dual-Purpose declaredWeight

`declaredWeight` determines:

1. **Gas budget** = `declaredWeight × INSTRUCTIONS_PER_WEIGHT_UNIT`
2. **Consensus weight** = subject to constraints from the trust module

The gas budget is a hard limit — exceed it and the computation is
invalid. The consensus weight may be adjusted by verification outcomes
(sampling module) but starts from `declaredWeight`.

### The Constraint: Backing Weight with Collateral

The trust module already requires collateral for blocks. The collateral
requirement is the natural constraint on weight inflation:

```
required_collateral(block) = declaredWeight × COLLATERAL_PER_WEIGHT
```

To declare high weight (and thus get a larger gas budget), you must
stake proportionally more collateral. This means:

- **Game tick publisher**: Needs weight W to get enough gas for 10M
  instructions. Must stake W × COLLATERAL_PER_WEIGHT. The bounty they
  earn must exceed this staking cost (opportunity cost of locked
  capital).

- **Weight inflator**: Could declare W = 1000 to gain consensus
  influence, but must stake 1000 × COLLATERAL_PER_WEIGHT. If their
  computation doesn't actually need 1000 units of gas, they're
  overpaying. The deception game makes this even worse — they might
  lose all that collateral.

### Does This Solve the Easy Trick Attack?

Partially. From weight.md:

> A contract that is computationally hard in general, but easy if you
> know a shortcut.

With collateral-backed weight:

1. Attacker discovers a shortcut for contract C that takes 1M
   instructions instead of 100M.
2. Contract's weight function declares weight proportional to 100M
   instructions (it doesn't know about the shortcut).
3. Attacker stakes collateral proportional to 100M-instruction weight.
4. Verification passes (computation is correct).
5. Attacker gains consensus weight cheaply in COMPUTATION, but not
   cheaply in COLLATERAL.

The collateral cost is the same whether you use the shortcut or not.
The shortcut only saves computation time, not staking cost. So the
easy trick gives a speed advantage (compute faster) but not an economic
advantage (same collateral requirement).

**Remaining vulnerability**: If the attacker has capital but low
computation power, the shortcut lets them produce MORE blocks per unit
time than honest participants. Each block requires the same collateral,
but the attacker can produce them faster. This is a throughput advantage,
not a per-block advantage.

**Mitigation**: Throughput balancing (from block-creation.md) limits how
many blocks a publisher can produce in a time window, regardless of
computational speed. This bounds the throughput advantage.

---

## Concrete Numbers

Let's work through a concrete example to check economic viability.

### Parameters

```
INSTRUCTIONS_PER_WEIGHT_UNIT = 1,000,000 (1M instructions per weight unit)
COLLATERAL_PER_WEIGHT = 10 (10 units of value per weight unit)
```

### Game Tick Example

A game tick contract:
- Execution: ~10M WASM instructions
- `declaredWeight` needed: 10 (for 10M instruction budget)
- Collateral required: 100
- Bounty earned per tick: 1

**Publisher's economics** (per tick):
```
Revenue:     +1 (bounty)
Cost:        -0 (computation is basically free for a modern machine)
Collateral:  100 (locked until aggregated, opportunity cost ~0.01)
Net per honest tick: +0.99
```

With deception game (E2 numbers: +1 honest, -1000 caught, +1M jackpot):
```
Honest EV:     +1
Trap caught:   -1000  (but collateral is 100, so trap cost = -100?)
```

Wait — there's a mismatch. The E2 analysis used abstract units. Let's
re-derive with concrete collateral.

### Deception Game with Collateral-Backed Weight

The deception game penalties come from collateral:

- **Caught**: Lose FOR collateral = `declaredWeight × COLLATERAL_PER_WEIGHT`
  = 10 × 10 = 100.
- **Jackpot**: Claim aggregator's collateral on the subtree containing
  the trap. The aggregator's collateral covers the entire subtree weight.

For a single game tick (weight 10) in a subtree of total weight 10,000:
```
Aggregator's collateral on subtree: 10,000 × 10 = 100,000
```

But the claiming limit is `encapsulated_weight × N`:
```
claim_limit = 10 × N
```

With N = 100: `claim_limit = 1,000`.

So:
```
Caught: -100 (own collateral)
Jackpot: +1,000 (capped by claiming limit)
Honest: +1 (bounty)
```

### Re-Deriving Equilibrium

Using E2's framework with these concrete numbers:

```
c = 100  (collateral lost when caught)
j = 1,000  (jackpot from self-catch)
b = 1  (honest bounty)

Deceiver EV = (1-p) × j - p × c
            = (1-p) × 1,000 - p × 100

Set EV(deceive) = EV(honest) = 1:
(1-p) × 1,000 - p × 100 = 1
1,000 - 1,000p - 100p = 1
999 = 1,100p
p ≈ 0.908
```

Catch rate of 90.8% at equilibrium. That's workable but lower than
E2's 99.9%. The ratio j/c = 10 instead of E2's j/c = 1000.

### The j/c Ratio Problem

E2 assumed j/c = 1,000,000/1,000 = 1,000. But with collateral-backed
weight and claiming limits:

```
j/c = (W × N) / (W × COLLATERAL_PER_WEIGHT)
    = N / COLLATERAL_PER_WEIGHT
```

This ratio is a CONSTANT determined by protocol parameters, independent
of block weight. With N = 100 and COLLATERAL_PER_WEIGHT = 10:

```
j/c = 100/10 = 10
```

This is much lower than E2's assumed 1,000. The equilibrium catch rate
is worse (90.8% vs 99.9%).

To get j/c = 1,000, we need N/COLLATERAL_PER_WEIGHT = 1,000. Options:

1. **N = 10,000, COLLATERAL_PER_WEIGHT = 10**: Very high claiming limit.
   A weight-10 fraud event allows claiming 100,000 in collateral. This
   means aggregators need enormous collateral buffers.

2. **N = 100, COLLATERAL_PER_WEIGHT = 0.1**: Very low collateral
   requirement. A weight-10 block only needs 1 unit of collateral.
   Makes staking nearly free, reducing skin-in-the-game.

3. **Accept j/c = 10**: The equilibrium catch rate is 90.8%. This
   means ~9% of computations are traps and ~0.8% get through uncaught.
   That seems too high for a reliable system.

### Resolving: Jackpot ≠ Claiming Limit

The j/c ratio doesn't have to equal N/COLLATERAL_PER_WEIGHT. The
jackpot comes from the AGGREGATOR's collateral, not from the claiming
limit:

The aggregator stakes collateral proportional to their SUBTREE's total
weight. A subtree with total weight S:

```
aggregator_collateral = S × COLLATERAL_PER_WEIGHT
```

When a trap is caught AFTER aggregation, the self-catcher claims from
the aggregator's pool. The claiming limit bounds this:

```
j = min(claim_limit, aggregator_collateral)
  = min(W × N, S × COLLATERAL_PER_WEIGHT)
```

For W = 10 (trap block weight), S = 10,000 (subtree weight):
```
j = min(10 × 100, 10,000 × 10)
  = min(1,000, 100,000)
  = 1,000
```

And c = W × COLLATERAL_PER_WEIGHT = 100.

So j/c = 10. The claiming limit is the binding constraint, not the
aggregator's collateral.

**Key observation**: The claiming limit N is the lever that controls the
deception game equilibrium. Higher N = higher jackpot = more profitable
deception = more verification = higher catch rate. But higher N also
means aggregators face higher per-fraud losses, which makes aggregation
more expensive.

### Equilibrium N

We want a catch rate that makes the system reliable. Target: p > 0.99
(less than 1% of traps go uncaught).

```
(1-p) × j - p × c = b
(1-p)(W × N) - p(W × COLLATERAL_PER_WEIGHT) = b
```

For p = 0.99:
```
0.01 × W × N - 0.99 × W × COLLATERAL_PER_WEIGHT = b
W(0.01N - 0.99 × COLLATERAL_PER_WEIGHT) = b
```

With W = 10, COLLATERAL_PER_WEIGHT = 10, b = 1:
```
10(0.01N - 9.9) = 1
0.01N - 9.9 = 0.1
0.01N = 10
N = 1,000
```

So N = 1,000 gives an equilibrium catch rate of 99%. With N = 1,000:
```
claim_limit = 10 × 1,000 = 10,000
j/c = 10,000/100 = 100
```

This means a weight-10 fraud event allows claiming up to 10,000 from
the aggregator. The aggregator's subtree collateral (100,000 for a
weight-10,000 subtree) can cover this, but the aggregator needs to price
this risk into their fees.

---

## Gas Budget Mechanics

### Instruction Counting

WASM instruction counting is well-understood. Each WASM instruction
costs 1 gas unit. Host function calls (output_data, block_output_data,
etc.) cost a fixed amount:

```
Cost schedule:
  WASM instruction:          1 gas
  output_data(bytes):        100 + len(bytes) gas
  block_output_data(i):      200 gas (memory read from block)
  oracle_fetch(request):     10,000 gas (network call, if supported)
  accept()/reject():         0 gas (terminal)
  memory allocation (page):  1,000 gas
```

Total gas budget:
```
gas_limit = declaredWeight × INSTRUCTIONS_PER_WEIGHT_UNIT
```

If the computation exceeds gas_limit before calling accept(), it's
treated as invalid (same as if it produced wrong output).

### Verifier Gas Budget

Verification re-executes the computation with the same inputs. The
verifier has the same gas budget. But what if the original publisher
used a shortcut that takes fewer instructions?

**No problem**: The verifier also runs the same WASM program. The WASM
program is deterministic — same inputs produce same execution trace.
There are no shortcuts within the same WASM binary. The "easy trick"
attack from weight.md only applies when the attacker uses a DIFFERENT
program or external knowledge to produce the result faster — but
verification re-runs the SAME program.

Wait — this is an important point. The "easy trick" in weight.md
assumes the attacker can produce correct results cheaply. But with
program-as-contract, the attacker must run the SAME program (the
contract WASM). The shortcut would need to be INSIDE the WASM program
(a branch that's easy to trigger) or involve pre-computation.

**Pre-computation attack**: The attacker pre-computes results for many
inputs and stores them. When a request arrives, they look up the answer
instead of computing it. The WASM still runs (they need to produce the
output through the program), but they already know the answer.

Pre-computation doesn't help because the WASM program is deterministic
and must be re-executed regardless. The attacker can't skip the
execution — they still need the gas budget. What pre-computation does
is let them predict WHICH computations to attempt (cherry-pick easy
inputs), but each execution still costs the same gas.

**Conclusion**: With program-as-contract, the "easy trick" attack is
largely neutralized for the gas budget dimension. Weight inflation
through the gas mechanism is not viable because the WASM execution
time is deterministic.

---

## Weight for Different Block Types

### Type 1: Pure Computation (Game Ticks)

```
declaredWeight: 10 (for 10M instruction budget)
collateral: 100
bounty earned: 1
consensus influence: weight 10
```

Low weight, low consensus influence. This is appropriate — a game tick
shouldn't dominate consensus. Many game ticks over time accumulate
into meaningful aggregate weight through aggregation.

### Type 2: Data Lookup (Hash Query)

```
declaredWeight: 0.01 (for 10K instruction budget — just hash check)
collateral: 0.1
bounty earned: 0.5
consensus influence: weight 0.01
```

Very low weight, very low gas. A hash check is cheap. The bounty is
what motivates the responder, not the weight. These blocks contribute
almost nothing to consensus, which is correct — looking up data is not
"work" in the consensus sense.

### Type 3: Heavy Computation (Compilation)

```
declaredWeight: 1,000 (for 1B instruction budget)
collateral: 10,000
bounty earned: 100
consensus influence: weight 1,000
```

High weight, high gas budget, high collateral. The high collateral
requirement means only well-capitalized nodes serve heavy computations.
This is a feature: heavy computation results have high consensus
influence AND high economic risk, making fraud both detectable and
costly.

### Type 4: Economic Transaction (Value Transfer)

```
declaredWeight: 1 (for 1M instruction budget — signature check)
collateral: 10
value transferred: 10,000
consensus influence: weight 1
```

Low weight despite high value. Under pure gas-based weight, a 10,000-
value transfer has the same consensus weight as a trivial computation.
This seems wrong — economic activity should carry consensus weight
proportional to its value.

**This is where the hybrid model (weight.md Option D) becomes
compelling.** Economic throughput provides a base weight, and gas
provides a cap:

```
effective_weight = max(gas_based_weight, economic_weight)
  where economic_weight = throughput × WEIGHT_PER_VALUE
  and gas_based_weight = instructions_used / INSTRUCTIONS_PER_WEIGHT_UNIT
```

But this complicates the gas limit: if effective_weight > gas_based_
weight, the block gets more consensus influence than its computation
cost would suggest. Is this a problem?

**No**: The gas limit is still based on the computation needed, not the
effective weight. A value transfer needs minimal gas (signature check)
but gets weight from its economic throughput. The two dimensions are
independent:

```
gas_limit = computation_weight × INSTRUCTIONS_PER_WEIGHT_UNIT
consensus_weight = max(computation_weight, economic_weight)
collateral_requirement = consensus_weight × COLLATERAL_PER_WEIGHT
```

This means economic transactions stake collateral proportional to their
economic weight, while computation blocks stake proportional to their
gas budget. Both are meaningful.

---

## The Hybrid Weight Model

### Definition

```
consensus_weight = computation_weight + economic_weight

where:
  computation_weight = declaredWeight (determines gas budget)
  economic_weight = sum(output_values) × WEIGHT_PER_VALUE
```

Additive rather than max, so both computation and economic activity
contribute to consensus.

### Gas Budget

```
gas_limit = computation_weight × INSTRUCTIONS_PER_WEIGHT_UNIT
```

Only the computation component determines the gas budget. Economic
weight does not grant additional gas.

### Collateral

```
required_collateral = consensus_weight × COLLATERAL_PER_WEIGHT
```

Both components contribute to collateral requirements.

### Deception Game Adjustment

The deception game applies to the COMPUTATION component only. Economic
weight is structurally verifiable (just check the output values) and
doesn't need the deception game.

```
c_deceiver = computation_weight × COLLATERAL_PER_WEIGHT  (at risk)
j_self_catch = computation_weight × N  (claimable)

Note: economic_weight collateral is NOT at risk from computation fraud.
Economic fraud (value mismatch) is caught by structural verification,
not by the deception game.
```

This cleanly separates the two weight sources: computation weight is
verified by the deception game, economic weight is verified
structurally.

### Impact on Game Tick Economics

Game tick (computation_weight = 10, economic_weight ≈ 0):
```
consensus_weight = 10
collateral = 100
gas budget = 10M instructions
```

Same as before. Pure computation blocks are unaffected by the hybrid
model.

### Impact on Value Transfer Economics

Value transfer (computation_weight = 1, economic_weight = 100):
```
consensus_weight = 101
collateral = 1,010
gas budget = 1M instructions
```

The value transfer now has meaningful consensus weight (101 vs. 1).
The collateral is higher, but it's proportional to the economic value
flowing through, which is appropriate.

---

## Verification Cost and Sampling

E5 proposed factoring verification cost into sampling priority:

```
priority(T) = swing × dampening / verification_cost(T)
```

With gas budgets, verification cost is directly derivable:

```
verification_cost(T) = computation_weight(T) × INSTRUCTIONS_PER_WEIGHT_UNIT × TIME_PER_INSTRUCTION
```

High-gas blocks are expensive to verify. The sampling module
deprioritizes them per unit of information gain.

### Problem: Expensive Blocks Are Under-Sampled

If verification cost is in the denominator, expensive blocks are
sampled less often. But expensive blocks are where the deception game
produces the biggest jackpots (more collateral at stake). Attackers
would concentrate traps in expensive blocks.

### Counter-Argument: Market Self-Correction

More traps in expensive blocks → more uncaught traps → higher expected
jackpot → more verifiers specialize in expensive blocks → catch rate
increases → equilibrium restores.

But the response time may be too slow. If expensive blocks take 10
seconds to verify and the sampling budget is 100 samples/minute, only
a small fraction can be expensive-block samples.

### Proposed Resolution

Don't divide by verification cost linearly. Use a dampened function:

```
priority(T) = swing × dampening / sqrt(verification_cost(T))
```

This still deprioritizes expensive blocks but less aggressively. The
square root reflects diminishing returns: an 100× more expensive block
is deprioritized by 10×, not 100×.

Or alternatively, allocate a fixed fraction of the verification
budget to expensive blocks:

```
total_verification_budget per time window:
  80% → blocks with computation_weight < threshold
  20% → blocks with computation_weight >= threshold
```

Within each bucket, priority is computed normally. This ensures expensive
blocks receive minimum verification attention regardless of cost.

---

## Fee Structure for Computation

### Who Pays?

The bounty for a computation comes from the output being claimed. When
Alice publishes a computation request (an output with contract = game
WASM hash), the output's value IS the bounty.

```
Alice's request output:
  contract: GAME_TICK_WASM_HASH
  value: 1  (bounty)
  data: state_N  (current game state)
```

Bob claims this output, runs the computation, produces:
```
Bob's block:
  claims: [Alice's output]
  outputs: [
    { contract: GAME_TICK_WASM_HASH, value: 0.9, data: state_N+1 },  // result + next request
    { contract: SIGNATURE, value: 0.1, data: ... }  // Bob's fee
  ]
```

Bob takes 0.1 as his fee and passes 0.9 forward as the next tick's
bounty. Over time, the bounty pool depletes unless someone adds value.

### Sustainable Game State

For a game that runs indefinitely, the bounty pool must be replenished.
Options:

1. **Players fund ticks**: Each player contributes value each tick.
   `bounty = sum(player_contributions)`. The game continues as long as
   players pay.

2. **Spectator funding**: Anyone can add value to the game state output.
   A "sponsor" output that adds value to the computation chain.

3. **Ad-supported**: The computation result includes advertising data.
   Advertisers fund the bounty through a separate output.

Option 1 is simplest and most natural. The game tick contract consumes
player inputs alongside the previous state:

```
Claims:
  [previous_state_output, player_A_move, player_B_move]

Outputs:
  [next_state_output]

Value: sum(claimed_values) → distributed to next_state + publisher_fee
```

This makes the game tick a multi-input computation that naturally
collects funding from players.

---

## The Weight Declaration Mechanism

### Who Declares Weight?

With program-as-contract, the contract WASM itself can declare weight
via a `weight()` export. But the publisher ultimately sets
`declaredWeight` on their block.

**Constraint**: `declaredWeight >= computed_weight`, where
`computed_weight` is what the WASM actually uses during execution.

The publisher can set `declaredWeight` HIGHER than needed (overpaying
for gas they don't use). They can't set it LOWER (execution would
exceed gas limit and fail).

**Why overpay?** To gain consensus influence. But overpaying requires
more collateral, making it expensive. This is the natural brake.

### Verification of Weight Declaration

Structural verification checks:
1. `declaredWeight >= 0` (trivial)
2. `collateral >= declaredWeight × COLLATERAL_PER_WEIGHT` (structural)
3. During computation verification: actual instructions used ≤ gas_limit

The sampling module catches cases where `declaredWeight` is grossly
inflated (computation uses 1M instructions but declares weight for
100M). The verifier re-runs the computation, observes it uses only
1M instructions, and can flag the discrepancy.

**But should this be a fraud event?** If the computation is correct
and the publisher overpaid for gas, is that fraud?

**No.** Overpaying for gas is not fraud — it's wasteful but not
dishonest. The publisher declared weight, staked collateral, and the
computation produced the correct result. They just didn't use their
full gas budget.

**But it IS weight inflation for consensus purposes.** The publisher
gains consensus influence beyond their computational contribution.

**Resolution**: The sampling module should use ACTUAL gas consumed
(observed during verification) as the verified weight, not the
declared weight. This naturally deflates inflated declarations:

```
verified_weight = (actual_gas / gas_limit) × declaredWeight
```

If a publisher declares weight 100 but the computation only uses 10%
of the gas budget, their verified weight is 10. The rest is treated
as unverified (the sampling module's Beta model reduces effective
weight for unverified portions).

This is elegant: verification already re-runs the computation, so
actual gas usage is observed as a side effect. No additional mechanism
needed.

---

## Summary

### Key Findings

1. **Weight and gas are related but not identical.** `declaredWeight`
   determines the gas budget (hard limit on WASM instructions) and
   contributes to consensus weight. Economic throughput also contributes
   to consensus weight (hybrid model).

2. **Collateral-backed weight prevents the easy trick attack** for the
   economic dimension. The attacker saves computation time but not
   staking cost. With program-as-contract, shortcuts within the same
   WASM binary don't exist (deterministic execution), so the attack
   surface is further reduced.

3. **The claiming limit N is the key lever** for the deception game
   equilibrium. With collateral-backed weight, j/c = N/COLLATERAL_PER_
   WEIGHT. For a 99% catch rate, N ≈ 1,000 with COLLATERAL_PER_WEIGHT
   = 10.

4. **Hybrid weight (computation + economic)** is the right model.
   Pure computation weight disadvantages economic activity; pure
   economic weight prevents computation-heavy blocks from existing.
   The hybrid additively combines both, with only computation weight
   determining the gas budget.

5. **Verified weight should use actual gas consumed**, not declared
   weight. This prevents weight inflation through gas overpayment.
   The sampling module naturally observes actual gas during re-execution.

6. **Verification cost should be dampened** in sampling priority, not
   divided linearly. `sqrt(verification_cost)` prevents expensive
   blocks from being systematically under-sampled.

7. **Multi-input computation** (game ticks consuming player moves +
   previous state) naturally solves the bounty sustainability problem.
   Players fund computation by providing valued inputs.

### Design Recommendations

1. **declaredWeight determines gas budget**:
   `gas_limit = declaredWeight × 1,000,000`

2. **Consensus weight is hybrid**:
   `consensus_weight = declaredWeight + economic_throughput × WEIGHT_PER_VALUE`

3. **Collateral scales with consensus weight**:
   `required_collateral = consensus_weight × COLLATERAL_PER_WEIGHT`

4. **Verified weight uses actual gas**:
   `verified_computation_weight = (actual_gas / gas_limit) × declaredWeight`

5. **Claiming limit N = 1,000** (or higher, tuned to desired catch rate).

6. **Sampling priority dampens verification cost**:
   `priority = swing × dampening / sqrt(verification_cost)`

---

## Comparison with E1-E6

### vs. Weight.md Options

This exploration resolves the weight.md open question in favor of a
**hybrid model** (closest to Option D) with a critical addition:
verified weight uses actual gas consumed, not declared weight. This
addresses the easy trick attack more effectively than any single option
from weight.md because it separates the economic and computation
dimensions.

### vs. E2 (Deception Game)

E2 used abstract units (c, j, b). This exploration grounds them in
concrete protocol parameters (COLLATERAL_PER_WEIGHT, N, gas budgets)
and discovers that the j/c ratio is determined by N/COLLATERAL_PER_WEIGHT.
This constrains the equilibrium and shows that N ≈ 1,000 is needed for
a reliable catch rate.

### vs. E5 (Critical Review)

E5 proposed "declaredWeight = gas budget" without working through the
implications. This exploration validates the proposal but adds the
hybrid model (economic throughput component) and the verified-weight-
from-actual-gas mechanism. Both are necessary for the model to work
across different block types.

### vs. E6 (Chain Dynamics)

Chain traps amplify the jackpot (E6). In the weight/gas model, the
amplified jackpot is bounded by the claiming limit: `j_chain ≤ W × N`
regardless of chain length. This bounds the deception game equilibrium
for chains, though aggregators still face higher total risk.

---

## Open Questions

1. **What is the right INSTRUCTIONS_PER_WEIGHT_UNIT?** This depends on
   target hardware. Browser WASM can execute ~100M instructions/second.
   A weight-1 computation (1M instructions) takes ~10ms. A weight-100
   computation (100M instructions) takes ~1 second. These seem
   reasonable for a browser-first protocol.

2. **Should WEIGHT_PER_VALUE be a protocol constant or market-driven?**
   A fixed ratio is simpler but may not reflect the actual economic
   value of different tokens/resources.

3. **How does the verified-weight-from-actual-gas mechanism interact
   with the consensus module?** The consensus module currently uses
   declared weight. Introducing verified computation weight adds
   complexity — the sampling module would need to report both the
   Beta distribution (for correctness) AND the gas utilization ratio
   (for weight accuracy).
