# Strategic Deception and Risk Transfer

This document specifies the game theory of collateral aggregation, risk transfer between publishers and aggregators, and the equilibrium fraud rate that emerges from self-flagging incentives.

For collateral structure and spending conditions, see [trust](trust.md). For verification mechanics, see [computation](computation.md).

---

## The Verification Incentive Problem

If no one publishes invalid blocks, verifiers earn nothing. If verifiers earn nothing, they stop verifying. If no one verifies, aggregators stop probing. If no one probes, fraud becomes costless.

A perfectly honest network has zero verification incentive, making it maximally vulnerable to the first attacker.

---

## Risk Transfer

When a publisher creates a block, they post collateral C (e.g., 1000) to back its validity. This collateral is locked until the risk is transferred to an aggregator.

**Risk transfer** is the process by which an aggregator takes on the collateral obligation for a block, freeing the publisher's original collateral. This should happen within seconds of publication.

### Mechanism

1. Publisher creates block B, posts collateral C.
2. Aggregator creates a collateral block that covers B (and potentially N other blocks), posting its own collateral of M * C per block.
3. Publisher's original collateral C is released for reuse.
4. The aggregator now bears the risk: if B is found invalid, the aggregator loses M * C.

The **payout multiplier M** determines how much the aggregator stakes relative to the original collateral. M can be less than 1 -- the aggregator can stake less than the original publisher. This is acceptable because older blocks are less likely to be fraudulent (they've survived longer without being contested).

### Self-Flagging

The critical dynamic: a deceptive publisher can publish an invalid block, wait for an aggregator to take on the risk, then flag their own block as invalid.

- The publisher knows the block is invalid (private information).
- The aggregator doesn't know (information asymmetry).
- After risk transfer, the publisher flags the block and claims a share of the aggregator's collateral.

The flagger receives share alpha (e.g., 50%) of the penalty. The remainder goes toward rewriting the graph (removing the invalid block and its descendants).

This is an adverse selection market (Akerlof's lemons problem). The aggregator knows some blocks may be lemons. Their verification rate is a rational response to this asymmetry.

---

## Game-Theoretic Model

### Parameters

| Symbol | Meaning | Example |
|--------|---------|---------|
| C | Publisher's collateral per block | 1000 |
| r | Net reward for publishing a valid block (after effort) | 1 |
| v | Cost to verify one block | 1 |
| M | Payout multiplier (aggregator loses M * C per invalid block) | 0.5 |
| alpha | Flagger's share of the penalty | 0.5 |
| f | Fee publisher pays aggregator for risk transfer | ~v |
| p | Equilibrium fraud rate | derived |
| q | Equilibrium verification rate | derived |

### Players and Strategies

**Publisher** chooses between:
- **Honest**: publish valid block, pay fee f, earn reward r. Net: `r - f`.
- **Deceptive**: publish invalid block, post collateral C, wait for risk transfer, self-flag.
  - If aggregator verifies and catches (prob q): lose C. Net: `-C`.
  - If aggregator doesn't verify (prob 1 - q): self-flag, earn `alpha * M * C`. Net: `alpha * M * C`.

**Aggregator** chooses per block:
- **Verify** (cost v): reject if invalid, accept if valid. Expected: `(1 - p) * f - v`.
- **Accept without verifying**: earn fee, risk penalty. Expected: `f - p * M * C`.

### Nash Equilibrium (Mixed Strategy)

Both players randomize. At equilibrium, each is indifferent between their strategies.

**Aggregator indifference** (verify vs. don't verify):

```
(1 - p) * f - v = f - p * M * C
p * (M * C - f) = v
p = v / (M * C - f)
p ≈ v / (M * C)          -- since f << M * C
```

**Publisher indifference** (honest vs. deceptive):

```
r - f = (1 - q) * alpha * M * C - q * C
q = (alpha * M * C - r + f) / (alpha * M * C + C)
```

**Competitive fee** (aggregators earn zero expected profit):

At equilibrium, `p * M * C = v`, so the aggregator's expected loss from unverified blocks equals v. The cost is v per block regardless of strategy mix:

```
f = v
```

The fee equals the verification cost, independent of M.

### Equilibrium Values by Payout Multiplier

With C = 1000, r = 1, v = 1, alpha = 0.5:

| M | Aggregator loses | Fraud rate p | Verification rate q | Fee f | Capital per block |
|---|---|---|---|---|---|
| 0.1 | 100 | 1.0% | 4.8% | ~1 | 100 |
| 0.5 | 500 | 0.2% | 20% | ~1 | 500 |
| 1 | 1,000 | 0.1% | 33% | ~1 | 1,000 |
| 2 | 2,000 | 0.05% | 50% | ~1 | 2,000 |
| 10 | 10,000 | 0.01% | 83% | ~1 | 10,000 |

### Interpreting the Equilibrium

The equilibrium is self-correcting:

- If fraud drops below p: verification becomes unprofitable, verifiers exit, fraud becomes cheaper, fraud rises back to p.
- If fraud rises above p: verification becomes profitable, more verifiers enter, fraud becomes riskier, fraud drops back to p.

At equilibrium, deception is not more profitable than honest publishing -- it is equally profitable with higher variance. Risk-averse publishers prefer honest work, so the actual fraud rate may be below the equilibrium prediction.

---

## Low M is Preferable

Low M (e.g., 0.5) is the preferred operating point for several reasons:

**Capital efficiency**: At M = 0.5, aggregators need 500 capital per block. At M = 10, they need 10,000. This is a 20x difference. Since centralized insurance clients manage most aggregated risk, lower capital requirements make the market more accessible.

**Aggregator simplicity**: At M = 0.5, aggregators only verify 20% of blocks (sampling). At M = 10, they verify 83%. Low verification rates make the aggregator's job cheap and fast -- they only need to probe a sample, not verify everything.

**Self-flagging provides fast detection**: The deceptive publisher is incentivized to flag their own block as soon as risk transfers, because delay risks someone else catching it first and claiming the reward. Detection is nearly instant regardless of the aggregator's verification rate.

**Fee is M-independent**: Publishers pay the same fee (~v) regardless of M. Low M doesn't cost publishers more.

### Self-Flagging is the Primary Detection Mechanism

Independent verification -- random bounty hunting by third parties -- is **structurally unprofitable** at equilibrium. A verifier who picks a random block, pays v to check it, and earns `alpha * M * C` if invalid has expected profit:

```
E = p * alpha * M * C - v
  = (v / (M * C)) * alpha * M * C - v     -- substituting equilibrium p
  = alpha * v - v
  = (alpha - 1) * v
  < 0                                      -- since alpha < 1
```

This holds for all M. The equilibrium fraud rate is exactly low enough to make bounty hunting a losing proposition. If it were profitable, more verifiers would enter, pushing p down, making it unprofitable again.

This means detection cannot rely on independent verifiers. Instead, **self-flagging by the deceptive publisher is the primary detection mechanism**. The publisher knows their block is invalid (private information) and races to flag it immediately after risk transfer. Delay risks someone else catching it first and claiming the reward. Detection is nearly instant.

The floor for M is therefore not about independent verification profitability. It is about the self-flagging incentive: `alpha * M * C` must be large enough relative to the publisher's effort cost that the deception game remains attractive enough to fund the verification layer at all.

---

## Partial Collateral Coverage

An aggregator covering N blocks at M * C each does not need to post N * M * C collateral. Instead, they post a fraction -- e.g., 10% of the worst case. With N = 1000 and M * C = 500, the aggregator posts 50,000 instead of 500,000.

This reserve covers the first discovered invalidities. In the rare case that more than 10% of covered blocks are invalid, the remaining ones go uncovered.

### Why This Works

At the equilibrium fraud rate (p = 0.2% for M = 0.5), the expected number of invalid blocks per 1000 is 2. A 10% reserve covers 100 blocks -- 50x the expected fraud. The probability of exceeding this under independent fraud is negligible.

**Correlated fraud is easier to detect, not harder.** If 200 out of 1000 blocks are invalid (correlated cause), a 20% random sample catches at least one with overwhelming probability:

```
P(catch) = 1 - (800/1000)^200 ≈ 1 - 10^-19
```

One hit should trigger the aggregator to reject the entire correlated batch or probe deeper. The more concentrated the fraud, the faster probing finds it.

### Reserve as Risk Parameter

The reserve ratio is a risk management choice, not a game-theoretic parameter. It does not affect the equilibrium (f, p, q are unchanged). Aggregators with lower reserves offer lower fees (less locked capital) but face ruin risk from tail events. The market finds the efficient level.

### Collateral Exhaustion is Self-Regulating

If a publisher knows the aggregator's reserve is nearly depleted from prior claims, they know their self-flag won't pay out. This **discourages** deception when the reserve is low -- a nice self-regulating property. But it also means late-discovered fraud in a bad batch goes uncovered.

---

## Collateral Decay

### Bayesian Risk Decay

A block starts with prior fraud probability p. Over time, if the block remains unchallenged, the posterior probability of invalidity decreases. Modeling detection as a Poisson process with rate lambda (detections per second):

```
P(invalid | unchallenged for t) = p * e^(-lambda * t) / (1 - p + p * e^(-lambda * t))
                                ≈ p * e^(-lambda * t)     -- since p << 1
```

Risk decays exponentially. Required collateral tracks this:

```
C(t) = M * C_0 * p * e^(-lambda * t)
```

### Detection Rate

lambda depends on how quickly invalid blocks get flagged. Since self-flagging is the primary detection mechanism (see above), lambda is driven by the attacker's own incentive to flag quickly -- they race to claim the reward before anyone else. In practice, lambda is high (seconds, not minutes).

For a subtree of K blocks, the total residual risk at time t:

```
risk(t) = K * M * C * p * e^(-lambda * t)
```

With K = 1000, M = 0.5, C = 1000, p = 0.002:

| Time (half-lives) | Residual risk per block | Total subtree risk | Collateral needed (10% reserve) |
|---|---|---|---|
| 0 | 1.0 | 1,000 | 50,000 |
| 1 | 0.5 | 500 | 25,000 |
| 3 | 0.125 | 125 | 6,250 |
| 5 | 0.031 | 31 | 1,550 |
| 10 | 0.001 | 1 | 50 |

### Re-Aggregation Cascade

Collateral can be released through successive re-aggregation as risk decays:

```
t=0:   Publisher posts 1000, aggregator A posts 50,000 for 1000 blocks
t=5s:  Aggregator B takes over, posts 1,550. A's 50,000 released.
t=30s: Aggregator C takes over, posts 50. B's 1,550 released.
t=60s: Subtree is effectively trust-finalized. Minimal collateral.
```

### Recursive Fees are Negligible

Each re-aggregation step charges its own fee. At level k, the re-aggregator decides: verify (cost v) or accept the risk (expected loss `p_k * C_k`)?

```
p_k ≈ p * e^(-lambda * t_k)     -- Bayesian decay
C_k ≈ M^k * C                    -- collateral shrinks each level
```

Only the first aggregation requires verification (where `p * M * C > v`). At every subsequent level, the residual risk is below v, so the re-aggregator accepts without checking. The total recursive fee converges:

```
F = v + sum_{k>=1} p * e^(-lambda * k * delta) * M^k * C
  = v + p * C * (M * e^(-lambda * delta)) / (1 - M * e^(-lambda * delta))
```

With delta = 5s, lambda = 1/s, M = 0.5:

```
F = 1 + 2 * (0.5 * e^-5) / (1 - 0.5 * e^-5) ≈ 1.007
```

**One fee, paid once, covers the block's entire lifecycle from publication to finality.**

---

## Throughput-Proportional Fees

Blocks vary in throughput T (coins in = coins out). Collateral is proportional to throughput: `C_i = k * T_i`. Verification sampling should also be proportional to throughput, since the aggregator's risk from each block scales with its collateral.

### The Equilibrium q is Throughput-Independent

Both the deception reward and penalty scale linearly with T_i:

```
deception payoff for block i:
  (1 - q) * alpha * M * k * T_i  -  q * k * T_i
= T_i * [(1 - q) * alpha * M * k  -  q * k]
```

The publisher is indifferent when the bracket is zero:

```
q = alpha * M / (1 + alpha * M)
```

This is the same q for all blocks regardless of throughput. The aggregator verifies each block with the same probability.

### But the Fee Scales with Throughput

The aggregator's expected loss from missed fraud on block i is `p * M * C_i`, which is proportional to T_i. A high-throughput block creates proportionally more risk. The fee should price this:

```
f_i = v * T_i / T_avg
```

Equivalently, there is a constant **aggregation tax rate** on throughput:

```
f_i / T_i = v / T_avg = constant
```

Every block pays the same fraction of its throughput. A 1-coin block and a 1,000,000-coin block both pay the same percentage. Flat fees would force small blocks to subsidize the risk of large ones.

Very small blocks where `f_i` falls below a practical minimum may not be worth aggregating individually, pushing toward batching small blocks before aggregation.

---

## Malicious vs. Strategic Fraud

The equilibrium above models **strategic deception**: publishers who plan to self-flag for profit. This is rational economic behavior that funds the verification layer.

**Malicious fraud** is different: an attacker publishes invalid blocks hoping the invalid state persists. They do not self-flag. At M = 0.5, only 20% of these are caught by the aggregator's probing. The remaining 80% must be caught by:

1. Application-layer users who notice incorrect state and flag it for the bounty.
2. Other publishers whose blocks depend on the fraudulent block's outputs.
3. Aggregators at subsequent re-aggregation steps who may probe the block.

Note that independent bounty hunting is structurally unprofitable at equilibrium (see "Self-Flagging is the Primary Detection Mechanism" above). Malicious fraud that evades the aggregator's initial probing relies on downstream consumers and dependent publishers to notice. This is a weaker detection guarantee than strategic fraud (which is self-correcting via self-flagging). The aggregator's probing rate q is the primary defense against malicious fraud.

---

## The Deception Equilibrium

A healthier equilibrium involves a low baseline fraud rate:

1. Some nodes occasionally publish invalid blocks.
2. Aggregators catch a fraction during probing.
3. The publisher self-flags the rest after risk transfer.
4. The fraud rate stabilizes at `p = v / (M * C)`.

### Why Publish Invalid Blocks?

If you publish an invalid block and an aggregator incorporates it without verifying, you can self-flag and claim their collateral. The aggregator staked on the validity of your block (by aggregating it), and you know it's invalid.

- **If you succeed** (aggregator doesn't catch it): you claim `alpha * M * C`.
- **If you fail** (aggregator probes and catches it): you lose C.

This creates a natural adversarial dynamic that funds the verification layer.

### Engineering the Equilibrium

The protocol controls the equilibrium through:

- **M (payout multiplier)**: Controls fraud rate and verification intensity. Lower M means higher fraud rate but cheaper aggregation. Protocol should set a minimum M.
- **alpha (flagger share)**: Controls the split between flagger reward and graph repair. Higher alpha incentivizes faster flagging. 50% is a reasonable starting point.
- **C (collateral)**: Controls the absolute stakes. Higher C means more skin in the game but higher capital requirements for publishers.
- **Claiming limits** (see [trust](trust.md)): Bound the maximum payout per fraud event to prevent disproportionate claims.

---

## Open Questions

1. **Minimum M**: The floor for M is not about independent verification profitability (which is structurally unprofitable at any M). Instead, M must be high enough that the aggregator's probing rate q provides adequate defense against malicious (non-self-flagging) fraud. With alpha = 0.5 and M = 0.5, q = 20% -- one in five malicious blocks caught. Is this sufficient?
2. **Detection rate lambda**: The Bayesian decay model requires estimating lambda. Self-flagging provides fast detection for strategic fraud, but lambda for malicious fraud depends on downstream consumers noticing. How do we estimate lambda conservatively for re-aggregation pricing?
3. **Reputation effects**: Nodes caught publishing invalid blocks may be deprioritized by peers in the gossip module. Does this create a secondary cost that suppresses the fraud rate below the healthy equilibrium?
4. **Verification cartels**: Can verifiers and publishers collude (publisher tips off verifier, they split the reward)? This may not be harmful -- the collateral still gets claimed, and the verification still happens. The "victim" is the aggregator who should have probed more carefully.
5. **Throughput distribution**: If the block throughput distribution is very skewed (a few huge blocks, many tiny ones), the aggregation tax rate `v / T_avg` may be impractical for tiny blocks. Should there be a minimum block throughput for direct aggregation, with smaller blocks required to batch first?

---

## Implementation

No implementation yet -- this is a future consideration pending the dispute module.
