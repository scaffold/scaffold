# Strategic Deception and Risk Transfer

This document specifies the game theory of collateral aggregation, risk transfer between publishers and aggregators, and the equilibrium fraud rate that emerges from self-flagging incentives.

For collateral structure and spending conditions, see [trust](trust.md). For verification mechanics, see [computation](computation.md).

---

## The Verification Incentive Problem

If no one publishes invalid blocks, verifiers earn nothing. If verifiers earn nothing, they stop verifying. If no one verifies, aggregators stop probing. If no one probes, fraud becomes costless.

A perfectly honest network has zero verification incentive, making it maximally vulnerable to the first attacker.

---

## Collateral and Insurance Model

When an author creates a block, they post two outputs. See [collateral-resolution](collateral-resolution.md) for the contract specification.

### Collateral (Author's Responsibility)

The author's FOR collateral for short-term validity. It decays exponentially back to the author:

```
collateral(t) = C1 * exp(-c * (now - block_timestamp))
```

The author remains responsible for responding to AGAINST challenges (hash preimage requests) for the block's lifetime. Collateral is never transferred to an aggregator.

If the block is valid: collateral decays back to author. Responding to challenges earns the AGAINST bond as profit.

If the block is invalid: collateral decays to the challenger instead. The decaying collateral makes data hiding unprofitable -- the longer the attacker waits, the less they earn.

### Insurance (Risk Transfer to Aggregator)

The author posts insurance as a deposit. Upon aggregation, most is returned to the author minus a fee approximating the verification cost. The aggregator posts their own insurance covering the entire subtree. Even if the original author is gone, the aggregator is always responsible.

If an invalid block is discovered, the aggregator's insurance pays:
- A finder's reward to whoever proved the invalidity.
- Victim restoration -- new outputs that mirror the incorrectly claimed outputs.

### Self-Flagging

The critical dynamic: a deceptive author can publish an invalid block, wait for an aggregator to include it, then prove their own block invalid.

- The author knows the block is invalid (private information).
- The aggregator doesn't know (information asymmetry).
- The author posts AGAINST on their own block. Their collateral is a wash (they're both poster and challenger). Their profit comes from the insurance finder's reward.

The aggregator's defense: probe blocks before aggregating. If they find an invalid block, they reject it (no insurance coverage, no finder's reward opportunity).

This is an adverse selection market (Akerlof's lemons problem). The aggregator knows some blocks may be lemons. Their verification rate is a rational response to this asymmetry.

### Challenge as Query

AGAINST challenges double as data queries. To descend into a subtree, post AGAINST collateral on a hash. The block creator responds with the preimage (earning the AGAINST bond), and the querier gets the data. This unifies verification and graph traversal into a single paid operation.

---

## Game-Theoretic Model

### Parameters

| Symbol | Meaning | Example |
|--------|---------|---------|
| C1 | Author's collateral (decaying) | 1000 |
| T | Block throughput (coins in = coins out) | 1000 |
| r | Net reward for publishing a valid block (after effort) | 1 |
| v | Cost to verify one block | 1 |
| c | Collateral decay constant (per second) | 0.3 |
| f | Aggregation fee (insurance risk transfer) | ~v * T / T_avg |
| R | Aggregator's insurance (proportional to T) | T |
| alpha | Finder's share of insurance payout | 0.5 |
| p | Equilibrium fraud rate | derived |
| q | Equilibrium verification rate | derived |

### Players and Strategies

**Publisher** chooses between:
- **Honest**: publish valid block, pay fee f, earn reward r. Collateral decays back. Net: `r - f`.
- **Deceptive**: publish invalid block, post collateral C1, wait for aggregation, self-flag.
  - If aggregator verifies and catches (prob q): block rejected, lose C1. Net: `-C1`.
  - If aggregator doesn't verify (prob 1 - q): self-flag, collateral is a wash, earn finder's reward `alpha * R`. Net: `alpha * R`.

**Aggregator** chooses per block:
- **Verify** (cost v): reject if invalid, accept if valid. Expected: `(1 - p) * f - v`.
- **Accept without verifying**: earn fee, risk insurance payout. Expected: `f - p * R`.

### Nash Equilibrium (Mixed Strategy)

Both players randomize. At equilibrium, each is indifferent between their strategies.

**Aggregator indifference** (verify vs. don't verify):

```
(1 - p) * f - v = f - p * R
p * (R - f) = v
p = v / (R - f)
p ≈ v / R              -- since f << R
```

Since R is proportional to throughput T, the fraud rate scales inversely with throughput.

**Publisher indifference** (honest vs. deceptive):

```
r - f = (1 - q) * alpha * R - q * C1
q = (alpha * R - r + f) / (alpha * R + C1)
```

**Competitive fee** (aggregators earn zero expected profit):

At equilibrium, `p * R = v`, so the aggregator's expected loss from unverified blocks equals v. The cost is v per block regardless of strategy mix:

```
f = v * T / T_avg
```

The fee is proportional to throughput (see "Throughput-Proportional Fees" below).

### Equilibrium Values

With R = T = 1000 (aggregator's insurance = throughput), C1 = 1000, r = 1, v = 1, alpha = 0.5:

```
p = v / R = 1 / 1000 = 0.1%
q = (alpha * R - r + f) / (alpha * R + C1) = (500 - 1 + 1) / (500 + 1000) = 33%
f = v * T / T_avg ≈ 1 (for average-throughput blocks)
```

The aggregator verifies 33% of blocks, the fraud rate is 0.1%, and the fee equals the verification cost.

### Interpreting the Equilibrium

The equilibrium is self-correcting:

- If fraud drops below p: verification becomes unprofitable, aggregators stop probing, fraud becomes cheaper, fraud rises back to p.
- If fraud rises above p: verification becomes profitable, aggregators probe more, fraud becomes riskier, fraud drops back to p.

At equilibrium, deception is not more profitable than honest publishing -- it is equally profitable with higher variance. Risk-averse publishers prefer honest work, so the actual fraud rate may be below the equilibrium prediction.

The decaying collateral adds a time dimension: the author must self-flag quickly to earn the maximum finder's reward. Delayed revelation earns less:

```
finder_reward(t) = alpha * R * exp(-c * t)
```

At c = 0.3: reward at 2s = 0.55 * alpha * R, at 30s ≈ 0. Data hiding is a dominated strategy.

---

## Detection Mechanisms

### Self-Flagging is the Primary Detection Mechanism

Independent verification -- random bounty hunting by third parties -- is **structurally unprofitable** at equilibrium. A verifier who picks a random block, pays v to check it, and earns `alpha * R` if invalid has expected profit:

```
E = p * alpha * R - v
  = (v / R) * alpha * R - v     -- substituting equilibrium p
  = alpha * v - v
  = (alpha - 1) * v
  < 0                           -- since alpha < 1
```

The equilibrium fraud rate is exactly low enough to make bounty hunting a losing proposition. If it were profitable, more verifiers would enter, pushing p down, making it unprofitable again.

Detection relies on **self-flagging by the deceptive publisher** and **the aggregator's probing**. The publisher knows their block is invalid (private information) and races to prove it immediately after aggregation.

### The Decaying Collateral Prevents Data Hiding

The author's collateral decays from the block's creation time. This eliminates the data hiding attack:

- An honest self-flagger acts within seconds: nearly full reward.
- A data-hiding attacker waits for aggregation + re-aggregation: reward has decayed to near zero.

The decay constant c = 0.2-0.3 per second (half-life ~2-3 seconds) creates a sharp cliff:

| Delay | Reward fraction |
|---|---|
| 1s | 74-82% |
| 3s | 41-55% |
| 10s | 5-14% |
| 30s | 0.0001-0.2% |

Immediate action is strictly dominant. There is no profitable "wait and reveal" strategy.

### AGAINST Challenges as Ongoing Verification

The AGAINST challenge mechanism provides continuous verification pressure. Any peer can challenge any hash in any block at any time by posting AGAINST collateral. If the block creator (or anyone with the data) cannot produce the preimage, the block is invalid and the challenger claims the decaying collateral.

This means blocks are only as trusted as they are responsive. A block whose publisher goes offline is vulnerable to challenges -- but because responding is profitable (the AGAINST bond), any peer with the data is incentivized to defend it.

---

## Partial Insurance Coverage

An aggregator covering N blocks does not need to post N * R_per_block total insurance. Instead, they post a fraction -- e.g., 10% of the worst case. With N = 1000 blocks, the aggregator reserves 10% of total insurance liability.

This reserve covers the first discovered invalidities. In the rare case that more than 10% of covered blocks are invalid, the remaining ones go uncovered.

### Why This Works

At the equilibrium fraud rate (p = 0.1%), the expected number of invalid blocks per 1000 is 1. A 10% reserve covers 100 blocks -- 100x the expected fraud.

**Correlated fraud is easier to detect, not harder.** If 200 out of 1000 blocks are invalid (correlated cause), a 33% random sample catches at least one with overwhelming probability:

```
P(catch) = 1 - (800/1000)^330 ≈ 1 - 10^-28
```

One hit should trigger the aggregator to reject the entire correlated batch or probe deeper. The more concentrated the fraud, the faster probing finds it.

### Reserve as Risk Parameter

The reserve ratio is a risk management choice, not a game-theoretic parameter. It does not affect the equilibrium (f, p, q are unchanged). Aggregators with lower reserves can offer lower fees (less locked capital) but face ruin risk from tail events. The market finds the efficient level.

---

## Collateral Decay

### Collateral Decay

The author's collateral decays from block creation:

```
C1(t) = C1_0 * exp(-c * t)
```

With c = 0.3 (half-life ~2.3s), most of the collateral returns to the author within seconds if unchallenged. This is the primary mechanism that makes data hiding unprofitable -- the collateral is gone before an attacker can exploit it.

### Insurance Decay

The aggregator's insurance responsibility decays more slowly. As a block ages without being contested, the posterior probability of invalidity decreases:

```
P(invalid | unchallenged for t) ≈ p * exp(-lambda * t)
```

The aggregator's required insurance reserve per block drops accordingly. Over hours to days, old blocks can be considered solidified -- the cumulative verification history makes invalidity overwhelmingly unlikely.

### Re-Aggregation Cascade

Insurance can be released through successive re-aggregation as residual risk drops:

```
t=0:    Publisher posts C1, aggregator A covers 1000 blocks
t=5s:   Collateral nearly fully decayed. Author's risk period is over.
t=60s:  Aggregator B re-aggregates at lower reserve. A's capital released.
t=hours: Subtree is effectively solidified. Minimal insurance reserve.
```

The aggregation fee is paid once per block. Re-aggregation at lower reserve levels is nearly free because the residual risk is below v.

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

**Malicious fraud** is different: an attacker publishes invalid blocks hoping the invalid state persists. They do not self-flag. At q = 33%, only one third of these are caught by the aggregator's probing. The remaining blocks must be caught by:

1. AGAINST challenges from peers traversing the graph (query-as-verification).
2. Application-layer users who notice incorrect state.
3. Other publishers whose blocks depend on the fraudulent block's outputs.

The AGAINST challenge mechanism provides continuous verification pressure beyond the initial aggregation probing. Any peer descending into a subtree naturally challenges hashes along the way. Blocks in active subtrees are regularly challenged as a byproduct of normal graph traversal. Blocks in abandoned subtrees receive fewer challenges but also affect fewer users.

---

## The Deception Equilibrium

A healthier equilibrium involves a low baseline fraud rate:

1. Some nodes occasionally publish invalid blocks.
2. Aggregators catch a fraction during probing.
3. The publisher self-flags the rest after risk transfer.
4. The fraud rate stabilizes at `p = v / R`.

### Why Publish Invalid Blocks?

If you publish an invalid block and an aggregator includes it without verifying, you can prove it invalid and claim the finder's reward from the aggregator's insurance. The aggregator staked on the validity of your block (by aggregating it), and you know it's invalid.

- **If you succeed** (aggregator doesn't catch it): you claim `alpha * R` (finder's reward).
- **If you fail** (aggregator probes and catches it): you lose C1.

This creates a natural adversarial dynamic that funds the verification layer.

### Engineering the Equilibrium

The protocol controls the equilibrium through:

- **C1 (collateral)**: Author's skin in the game for short-term validity. Higher C1 means more deterrence but higher capital requirements.
- **c (decay constant)**: Controls how fast the collateral decays. Higher c means faster decay, stronger deterrence against data hiding, but less reward for legitimate late detection.
- **R (insurance)**: Proportional to throughput. Controls the aggregator's incentive to probe and the self-flagger's reward.
- **alpha (finder's share)**: Controls the split between finder reward and victim restoration. Higher alpha incentivizes faster detection. 50% is a reasonable starting point.
- **Claiming limits** (see [trust](trust.md)): Bound the maximum payout per fraud event to prevent disproportionate claims.

---

## Open Questions

1. **Decay constant c**: Needs calibration. c = 0.2-0.3/s gives a half-life of 2-3 seconds. Is this the right balance between rewarding honest detection and punishing data hiding?
2. **Minimum AGAINST bond**: The market should determine what's worth responding to, but is there a risk of dust challenges harassing publishers? A minimum might be needed.
3. **Finder's reward fraction (alpha)**: What fraction of the insurance payout goes to the finder vs. victim restoration? If too small, nobody looks. If too large, victims not fully restored.
4. **Computational validity disputes**: Hash challenges handle structural validity (self-resolving). How are disputes about computational correctness (WASM re-execution) handled? This likely still needs a separate mechanism.
5. **Throughput distribution**: If the block throughput distribution is very skewed (a few huge blocks, many tiny ones), the aggregation tax rate `v / T_avg` may be impractical for tiny blocks. Should there be a minimum block throughput for direct aggregation, with smaller blocks required to batch first?
6. **Reputation effects**: Nodes caught publishing invalid blocks may be deprioritized by peers in the gossip module. Does this create a secondary cost that suppresses the fraud rate below the healthy equilibrium?
7. **Verification cartels**: Can verifiers and publishers collude (publisher tips off verifier, they split the reward)? This may not be harmful -- the collateral still gets claimed, and the verification still happens. The "victim" is the aggregator who should have probed more carefully.

---

## Implementation

No implementation yet -- this is a future consideration pending the dispute module.
