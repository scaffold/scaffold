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

### The Independent Verification Layer

Low M means aggregators catch less fraud proactively. This is acceptable because a second layer of independent verifiers can check blocks post-aggregation.

The bounty for catching fraud is `alpha * M * C`. Even at M = 0.1, this is 50 units -- far more than the verification cost v = 1. Independent verifiers can profitably sample aggregated blocks at random, providing a safety net for fraud that aggregators miss.

The floor for M is where `alpha * M * C` approaches v. Below that, independent verification becomes unprofitable and post-hoc fraud detection breaks down.

### Collateral Decay

M can decrease over time through re-aggregation. Fresh blocks carry full publisher collateral (C = 1000). After a few seconds, an aggregator takes over at M = 0.5 (500). Later, another aggregator re-aggregates at an even lower M. Collateral decays as blocks age without being contested -- like insurance premiums dropping on a claim-free policy.

This reflects the Bayesian reality: blocks that survive longer without dispute are less likely to be fraudulent.

---

## Malicious vs. Strategic Fraud

The equilibrium above models **strategic deception**: publishers who plan to self-flag for profit. This is rational economic behavior that funds the verification layer.

**Malicious fraud** is different: an attacker publishes invalid blocks hoping the invalid state persists. They do not self-flag. At M = 0.5, only 20% of these are caught by the aggregator. The remaining 80% must be caught by:

1. Independent verifiers sampling post-aggregation (bounty: `alpha * M * C`).
2. Application-layer users who notice incorrect state.
3. Other publishers whose blocks depend on the fraudulent block's outputs.

The independent verification bounty is the primary defense. As long as `alpha * M * C >> v`, malicious fraud is eventually caught with high probability.

---

## The Deception Equilibrium

A healthier equilibrium involves a low baseline fraud rate:

1. Some nodes occasionally publish invalid blocks.
2. Aggregators catch a fraction during probing.
3. The publisher self-flags the rest after risk transfer.
4. Independent verifiers provide a backstop for non-self-flagged fraud.
5. The fraud rate stabilizes at `p = v / (M * C)`.

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

1. **Minimum M**: What is the lowest acceptable M? Bounded by `alpha * M * C > v` for independent verification profitability. With alpha = 0.5, C = 1000, v = 1: M > 0.002. In practice, the floor should be higher to ensure robust detection.
2. **Collateral decay schedule**: How quickly should M decrease through re-aggregation? Should it be a fixed schedule or market-driven?
3. **Reputation effects**: Nodes caught publishing invalid blocks may be deprioritized by peers in the gossip module. Does this create a secondary cost that suppresses the fraud rate below the healthy equilibrium?
4. **Verification cartels**: Can verifiers and publishers collude (publisher tips off verifier, they split the reward)? This may not be harmful -- the collateral still gets claimed, and the verification still happens. The "victim" is the aggregator who should have probed more carefully.
5. **M < 1 and graph integrity**: When M < 1, the total collateral backing a block decreases after aggregation. Is there a risk that re-aggregation at very low M makes fraud too cheap to deter, even if detection is profitable for verifiers?

---

## Implementation

No implementation yet -- this is a future consideration pending the dispute module.
