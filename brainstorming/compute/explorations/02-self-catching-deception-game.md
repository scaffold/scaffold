# Exploration 2: The Self-Catching Deception Game

## Direction

Deep-dive into the specific mechanics and game theory of the
"self-catching" deception equilibrium from the prompt: publishers
are incentivized to occasionally publish invalid blocks, and if
nobody catches them, the publisher self-catches and claims a massive
jackpot. This exploration focuses on the protocol primitives needed,
the Nash equilibrium analysis, and how self-catching specifically
solves the MITM re-attribution problem.

---

## The Core Mechanism

### Insurance Commitments

The key primitive is the **insurance commitment** — a commitment to the
correct result, published alongside (or before) a deceptive block. It
proves the publisher *knew* the correct answer at time of publication.

```
Insurance output (on a separate block):
  contract: DECEPTION_INSURANCE
  value: 0
  data: {
    commitment: HASH(correct_result || secret)
  }
```

The insurance output does NOT reference the target block. The link is
established at self-catch time. This prevents verifiers from identifying
which blocks have insurance (and therefore might be traps).

### Self-Catch Flow

1. Publisher computes correct result R for program P on input I.
2. Publisher publishes a **deceptive block** with wrong result R'.
3. Publisher publishes FOR collateral on the deceptive block (making it
   look legitimate).
4. Publisher publishes an **insurance block** with commitment
   `HASH(R || secret)`.
5. Time passes. The sampling module may or may not verify the block.

**If caught by a third-party verifier:**
- Verifier posts AGAINST collateral with re-execution evidence.
- Dispute resolves: verifier wins, publisher loses FOR collateral.
- Publisher loses: -c (collateral).
- Insurance commitment becomes worthless (can't self-catch after someone
  else caught it).

**If nobody catches it:**
- The block is aggregated. The aggregator stakes collateral.
- Self-catch delay passes.
- Publisher **reveals** the insurance: provides R and secret.
- Protocol verifies: `HASH(R || secret) == commitment` AND
  `execute(P, I) == R != R'` AND insurance was published at or
  before the deceptive block's anchor depth.
- Publisher claims the aggregator's collateral (the jackpot).
- Publisher's own FOR collateral is lost (they proved their own block
  invalid).

### Why Not Just Post AGAINST?

Without the insurance commitment, anyone could "self-catch" by
re-executing and posting AGAINST. The insurance commitment ensures
only the **original publisher** can claim the jackpot:

- The commitment proves foreknowledge of the correct result.
- It must exist at or before the deceptive block's publication time.
- A verifier who discovers fraud through re-execution can only earn
  the normal AGAINST reward, not the jackpot.

This distinction is what makes the MITM defense work.

---

## Game Theory

### Variables

```
r   = reward for honest computation (e.g., +1)
c   = collateral lost when caught by peer (e.g., -1000)
j   = jackpot for successful self-catch (e.g., +1,000,000)
p   = probability of being caught by a third-party verifier
f   = fraud rate (fraction of blocks that are deceptive)
V   = cost of one verification (re-execution)
```

### Publisher Equilibrium

A publisher chooses between honest and deceptive for each block.

```
EV_honest    = r
EV_deception = (1 - p) * j - p * c
```

At equilibrium, publishers are indifferent:

```
(1 - p) * j - p * c = r
p = (j - r) / (j + c)
```

With the prompt's numbers (+1, -1000, +1,000,000):
```
p = (1,000,000 - 1) / (1,000,000 + 1,000) ≈ 0.999
```

**At equilibrium, 99.9% of deceptive blocks are caught.** This means
verification is extremely active — the verification layer is well-funded.

### Verifier Equilibrium

A verifier chooses how many blocks to verify. Each verification costs V.

```
EV_per_verification = f * c - V
```

At equilibrium, verification is marginally profitable (EV = 0):
```
f = V / c
```

With V = 1 (same as honest reward) and c = 1000:
```
f = 1/1000 = 0.1%
```

**The equilibrium fraud rate is 0.1%.** One in every 1000 blocks is a
trap. This is low enough that the network mostly works correctly, but
high enough to fund continuous verification.

### Aggregator Equilibrium

An aggregator rolling up N blocks faces expected fraud exposure:

```
expected_fraud_blocks = N * f = N / 1000
expected_loss = expected_fraud_blocks * aggregator_collateral_per_block
```

The aggregator probes K blocks to reduce exposure. If they find no fraud
in K samples, their posterior fraud rate estimate is bounded:

```
P(fraud | 0 caught in K samples) ≈ f * (1 - f)^K ≈ f * e^(-fK)
```

Optimal probe depth: enough that expected loss from undetected fraud
is less than aggregation fees. With f = 0.001:

```
K ≈ 10-20 samples    → P(missing fraud) ≈ e^(-0.01 to -0.02) ≈ 0.98-0.99
```

This means aggregators verify about 1-2% of the blocks they aggregate.
The remaining 98-99% are trusted based on the sampling statistics plus
the economic pressure from the deception game.

### Self-Correcting Dynamics

The equilibrium is self-correcting:

```
fraud↓ → verification unprofitable → verifiers exit
       → p↓ → deception more profitable → fraud↑ → equilibrium

fraud↑ → verification very profitable → verifiers enter
       → p↑ → deception less profitable → fraud↓ → equilibrium
```

No protocol intervention needed — the equilibrium emerges from
rational behavior.

---

## MITM Re-Attribution Analysis

### Expensive Computations (game ticks, compilations)

MITM intercepts a computation result block. Their options:

**Option A: Re-publish as their own (without verifying)**
```
EV = (1 - f) * r - f * c    // don't know if it's a trap
   = 0.999 * 1 - 0.001 * 1000
   = 0.999 - 1.0
   = -0.001
```

**Negative expected value.** The MITM can't self-catch (no insurance
commitment), so they bear full downside risk of traps. Re-attribution
is unprofitable on average.

**Option B: Verify first, then re-publish if valid**
```
EV = r - V    // always +1, but costs V to verify
   = 1 - 1
   = 0
```

Zero expected value (same as doing honest computation). The MITM gains
nothing over just computing the answer themselves. Plus they lose the
time-to-verify race window where another responder might claim the
bounty.

**Option C: Just relay the block (no re-attribution)**
No economic gain, but also no risk. The MITM acts as a good gossip
peer.

**Conclusion: MITM re-attribution is either unprofitable (A) or
zero-profit (B) for expensive computations.** The deception game
provides strong MITM protection without any commitment scheme.

### Cheap-to-Verify Computations (hash lookups)

MITM intercepts a data response with hash H and payload D.

**Option A: Verify (trivial), then re-publish**
```
EV = r - trivial_cost ≈ r    // verify hash(D) == H, costs ~0
```

The MITM can filter out traps cheaply. Re-attribution is profitable.

**Conclusion: The deception game alone does NOT protect against MITM
for trivially verifiable computations.** The commitment scheme from
Exploration 1 is still needed for this case.

### The Verification-Cost Threshold

There's a critical threshold where MITM re-attribution becomes
unprofitable:

```
Break-even: (1 - f) * r = f * c
f_critical = r / (r + c) = 1 / 1001 ≈ 0.001
```

This happens to equal the equilibrium fraud rate! So MITM is exactly
marginal at equilibrium — any increase in fraud rate makes it
unprofitable, any decrease makes it profitable.

The MITM's strategy depends on their verification cost V_mitm:

```
If V_mitm > f * (c + r):  Can't profitably filter traps. MITM loses.
If V_mitm < f * (c + r):  Can filter traps. MITM breaks even or profits.
If V_mitm ≈ 0:            Can perfectly filter traps. MITM always profits.
```

This creates a clean spectrum:
- Heavy computation (V_mitm ≈ V): deception game protects
- Medium computation: partial protection
- Trivial verification (V_mitm ≈ 0): no protection, need commitment

---

## Payoff Sources

### Where the -1000 comes from

The publisher posted FOR collateral of value c. When caught, the
verifier claims this collateral through the existing trust module's
dispute mechanism.

### Where the +1,000,000 comes from

The block was aggregated without being caught. The aggregator posted
FOR collateral proportional to the aggregated weight. The publisher
self-catches by proving the block invalid, claiming the aggregator's
collateral.

The jackpot is naturally proportional to the aggregation level. Higher-
level aggregations (rolling up more work) have more collateral at stake,
creating larger jackpots. This means:

- **Low-level traps** (small aggregations): small jackpots, small risk.
  High frequency, low stakes.
- **High-level traps** (large aggregations): huge jackpots, high risk.
  Low frequency, high stakes.

The ratio j/c is what determines the equilibrium. If aggregators
typically stake 1000x the publisher's collateral, the prompt's numbers
(j = 1,000,000, c = 1,000) emerge naturally.

### Value Conservation

Is value created or destroyed? No — it flows:

```
Honest case:
  Requester pays bounty → Publisher earns bounty − fees
  Publisher FOR collateral → returned after aggregation

Caught deception:
  Publisher FOR collateral → Verifier (reward for catching)
  Publisher bounty → still earned (block may be replaced)

Successful self-catch:
  Publisher FOR collateral → lost (self-proven fraud)
  Aggregator FOR collateral → Publisher (jackpot)
```

All value flows are zero-sum transfers between participants. The
deception game doesn't create or destroy value; it redistributes
it to fund verification.

---

## Making Insurance Standard Practice

A key question: should insurance commitments be published only for
deceptive blocks, or for ALL blocks?

### Insurance Only for Traps

Pro: Minimal overhead. Only deceptive blocks carry insurance.
Con: The presence of an insurance commitment is a signal that the
block might be a trap. Verifiers could monitor insurance commitments
and prioritize blocks that have them.

This defeats the purpose — traps should be indistinguishable from
honest blocks.

### Universal Insurance

Every publisher publishes an insurance commitment for every block.

```
For honest blocks:
  Insurance commitment = HASH(correct_result || secret)
  The correct result matches the block's claimed result.
  Self-catching would prove the block is valid, not invalid.
  The insurance is never revealed.

For deceptive blocks:
  Insurance commitment = HASH(correct_result || secret)
  The correct result differs from the block's claimed result.
  Self-catching proves invalidity.
```

Pro: No signal. All blocks look identical.
Con: Extra block per computation. However, the insurance commitment
is tiny (one hash output) and could potentially be folded into the
FOR collateral block.

**Recommendation: universal insurance.** The cost is minimal (one
extra hash in the collateral block's outputs), and it eliminates
information leakage about which blocks are traps.

### Folding Insurance into FOR Collateral

Since FOR collateral is already a separate block from the work block
(trust module rule), the insurance commitment can be an additional
output on the FOR collateral block:

```
FOR collateral block:
  outputs: [
    { contract: COLLATERAL, value: 1000,
      data: { target: H, side: "for", path: [] } },
    { contract: DECEPTION_INSURANCE, value: 0,
      data: { commitment: HASH(result || secret) } }
  ]
```

This adds zero extra blocks. The insurance is just a bonus output
on the collateral block the publisher was creating anyway.

---

## Self-Catch Timing and Conditions

### Self-Catch Window

The self-catch must happen AFTER the block is aggregated (otherwise
there's no aggregator collateral to claim) and within a bounded
window:

```
Self-catch conditions:
  1. Target block H has been aggregated by aggregator A
  2. Insurance commitment was published at or before H's anchor depth
  3. Self-catch delay D has passed since aggregation
  4. No third-party AGAINST posting exists for H
  5. Publisher reveals: correct_result R, secret S
  6. Verification: HASH(R || S) == commitment
     AND execute(program, input) == R
     AND R != block's claimed result
```

### Why the Self-Catch Delay?

The delay gives third-party verifiers a fair window to catch fraud.
Without a delay, the publisher could self-catch immediately after
aggregation, giving verifiers no chance.

The delay should be long enough that:
- The sampling module has had time to reach the block
- Verifiers have had time to re-execute and post AGAINST
- But short enough that the publisher's capital isn't locked forever

This delay is similar to the existing "risk period" in the trust
module before collateral can be redeemed.

### Race Conditions

What if a verifier posts AGAINST at the same time the publisher
self-catches?

Resolution: first-to-publish wins. If the AGAINST collateral is
published before the self-catch reveal, the verifier gets the reward.
If the self-catch reveal is published first, the publisher gets the
jackpot. The canonical ordering of blocks resolves the race.

---

## Impact on the Three Prompt Goals

### Goal 1: Incentivize Verification

The self-catching mechanism funds verification through a natural
economic cycle:

```
Publishers plant traps → Verifiers are profitable →
Verifiers stay active → Network remains secure
```

The equilibrium fraud rate (0.1% with the prompt's numbers) ensures
verifiers always have some work to do. The verification layer never
starves.

Quantitatively: if 1,000,000 blocks are published per day, ~1,000
are traps. If each trap carries 1,000 units of collateral, verifiers
earn ~1,000,000 units per day total. This is the "verification tax"
funded entirely by strategic publishers who also earn it back through
occasional jackpots.

### Goal 2: Incentivize Flagging Own Invalid Blocks

With universal insurance, publishers always commit to their computed
result. If they later discover an error (accidental, not strategic):

- They can self-catch, earning the jackpot minus their FOR collateral.
- This is strictly better than staying silent (where they'd lose
  their FOR collateral AND potentially cause cascading errors in
  dependent blocks).
- Early self-catching is especially valuable because it flags the
  block before others build on top of it.

The incentive to flag errors is proportional to the jackpot, which is
proportional to the aggregation level. This means errors in more
important (more widely used) computations have stronger flagging
incentives — exactly the right scaling.

### Goal 3: Prevent MITM Re-Attribution

For expensive computations:
- MITM can't self-catch (no insurance commitment).
- Re-attribution without verification is negative EV.
- Re-attribution with verification is zero EV.
- Conclusion: MITM gains nothing.

For cheap computations:
- MITM can filter traps by verifying cheaply.
- Re-attribution remains profitable.
- Conclusion: commitment scheme still needed (see Exploration 1).

The deception game provides the FIRST layer of MITM defense. The
commitment scheme provides the SECOND layer for cheap-to-verify
computations. Together, they cover the full spectrum.

---

## What This Requires from the Protocol

### New Contract Types

```
DECEPTION_INSURANCE:
  data: { commitment: Hash }
  Spending condition: Reveal R, S such that HASH(R || S) == commitment,
    AND identify target block H where execute(H.program, H.input) == R
    AND R != H.claimed_result,
    AND insurance published at/before H's anchor depth,
    AND no prior AGAINST on H exists,
    AND self-catch delay has passed since H was aggregated.
  Claim target: aggregator's FOR collateral on the aggregation
    containing H.
```

### Modifications to Existing Primitives

**Trust module**: Add self-catch as a spending condition on aggregator
FOR collateral. When an insurance commitment is successfully revealed,
the aggregator's collateral can be claimed by the insurance holder.

**Sampling module**: No changes. The sampling module verifies blocks
regardless of whether they're traps. The deception game is invisible
to the sampling module — it just verifies computations.

**Collateral contract**: Add a condition: aggregator FOR collateral
can be spent by a valid self-catch reveal.

### No Block Schema Changes

The deception game operates entirely through contracts and outputs.
No changes to the block structure:

```
Block { anchor, aggregates, claims, outputs, declaredWeight, creator, signature }
```

Insurance commitments are outputs. Self-catch reveals are blocks.
Everything fits the existing architecture.

---

## Development Experience

### Automatic Insurance (Framework Level)

The framework handles insurance automatically:

```typescript
// Publisher side — insurance is transparent
const block = await scaffold.publishComputation({
    program: 'game-tick.wasm',
    input: currentState,
    result: computedNextState,
    collateral: 1000,
    // Insurance commitment is generated internally
    // Secret is stored locally for potential self-catch
});

// The framework:
// 1. Computes the result
// 2. Creates FOR collateral block
// 3. Adds insurance commitment output to collateral block
// 4. Stores secret locally
// 5. Monitors for self-catch opportunities
```

### Deception Mode (Opt-In)

```typescript
// Enable strategic deception (opt-in)
scaffold.setDeceptionStrategy({
    enabled: true,
    fraudRate: 'auto',  // calibrate to network conditions
    // or: fraudRate: 0.001,  // fixed 0.1%
});

// When enabled, the framework occasionally:
// - Publishes wrong results intentionally
// - Monitors whether the trap was caught
// - Self-catches if the deadline passes
// - Tracks ROI of deception vs honest computation
```

### For Verifiers

```typescript
// Verification is just computation re-execution
scaffold.enableVerification({
    priorityModel: 'sampling',  // use sampling module priorities
    maxConcurrent: 4,           // verify up to 4 blocks in parallel
});

// The framework:
// 1. Selects blocks to verify (sampling priority)
// 2. Fetches computation data (program, input, oracle log)
// 3. Re-executes and compares
// 4. Posts AGAINST if mismatch
// 5. Tracks verification profitability
```

---

## Parameter Sensitivity

The equilibrium depends on the ratio j/c:

| j/c Ratio | p (catch rate) | f (fraud rate, V=1) | Notes |
|-----------|---------------|---------------------|-------|
| 100 | 0.99 | 1% | High fraud, active verification |
| 1,000 | 0.999 | 0.1% | Balanced — prompt's numbers |
| 10,000 | 0.9999 | 0.01% | Low fraud, minimal verification |
| 1,000,000 | 0.999999 | 0.0001% | Near-zero fraud, dormant verification |

The j/c ratio is determined by the relative stakes: how much does the
aggregator risk vs. the publisher? This is an emergent property of the
trust module's collateral requirements, not a protocol parameter that
needs tuning.

If aggregators must stake proportional to the weight they aggregate,
and publishers must stake proportional to their declared weight, then:

```
j/c ≈ aggregated_weight / declared_weight
```

For a tree with 1000 leaves, the aggregator stakes 1000x a single
leaf's collateral, giving j/c ≈ 1000. This naturally produces the
prompt's numbers.

---

## Open Questions

1. **Insurance revelation timing**: Should the self-catch delay be a
   fixed number of anchor depths, or proportional to the block's
   weight? Heavier blocks might need longer verification windows.

2. **Multi-level self-catching**: If a deceptive block is aggregated at
   level L1, then L1 is aggregated at level L2, can the publisher
   self-catch against L2's aggregator (bigger jackpot)? This could
   incentivize waiting, but the risk of someone catching the fraud
   increases with time.

3. **Insurance privacy**: Even with universal insurance, the commitment
   value might leak information. If `HASH(R || S)` can be precomputed
   by someone who has R (the claimed result), they could check whether
   the insurance matches the claimed result. The secret S prevents this,
   but S must be large enough to prevent brute-force.

4. **Deception strategy optimization**: What's the optimal fraud rate
   for a publisher? The equilibrium analysis assumes publishers are
   indifferent, but in practice, publishers with lower verification
   costs or better timing might have asymmetric advantages.

5. **Collateral coordination**: The publisher posts FOR collateral
   while knowing the block is invalid. If the collateral amount is
   large relative to the publisher's capital, this limits how often
   they can deceive. Is this a feature (rate-limiting deception) or
   a bug (preventing healthy fraud rate)?

6. **Verifier collusion**: Can a publisher tip off a friendly verifier
   to catch their trap, splitting the reward? This is the same as
   deception.md's "verification cartel" question. It may not be harmful
   — the verification still happens.

---

## Comparison with Other Approaches

### vs. Exploration 1 (Computation-Oracle Model)

Exploration 1 focused on HOW computations are represented and verified
(oracle logs, two-level verification). This exploration focuses on WHY
verification happens (economic incentives, deception equilibrium).

They're complementary: Exploration 1 provides the verification
mechanism, Exploration 2 provides the verification incentive. Together
they form a complete picture.

Exploration 1 noted that MITM protection "varies by computation type"
and needs commitment schemes for cheap verifications. This exploration
quantifies that claim: MITM re-attribution is exactly marginal at the
equilibrium fraud rate, with verification cost determining which side
of marginal you fall on.

### vs. Deception.md (Current Protocol Doc)

Deception.md describes the equilibrium at a high level. This
exploration adds:
- The **insurance commitment** primitive for self-catching
- **Quantitative equilibrium analysis** with concrete numbers
- **MITM protection as an emergent property** of the deception game
- **Universal insurance** as the recommended approach
- **Integration with trust module** (folding insurance into FOR
  collateral blocks)

### vs. Legacy2 Collateral Voting

The legacy2 approach used complex multi-phase voting (VALID_CHALLENGE,
ALL_VALID_CONTEST, etc. — 7 vote types). The self-catching deception
game is simpler: just FOR and AGAINST collateral (already in the trust
module) plus an insurance commitment. The complex voting hierarchy
isn't needed when verification is deterministic (re-execute WASM,
compare result).

---

## Summary

The self-catching deception game provides:

1. **A self-sustaining verification economy** — publishers fund
   verifiers through intentional traps, creating a steady-state
   equilibrium where verification is always marginally profitable.

2. **Natural MITM protection** — for expensive computations, the
   deception game makes re-attribution negative expected value. For
   cheap computations, it's insufficient and needs the commitment
   scheme from Exploration 1.

3. **Error flagging incentives** — universal insurance gives all
   publishers an incentive to flag their own errors (accidental or
   intentional), earning the jackpot instead of losing collateral.

4. **No schema changes** — insurance commitments are outputs on FOR
   collateral blocks. Self-catch reveals are blocks. Everything uses
   existing primitives.

5. **Quantifiable equilibrium** — the fraud rate, verification rate,
   and aggregator probing depth are all deterministic functions of the
   collateral ratios, which emerge naturally from the trust module's
   weight-proportional staking.
