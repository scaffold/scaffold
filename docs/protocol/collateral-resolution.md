# Collateral Resolution Contract

This document specifies the collateral resolution contract -- the mechanism by which blocks are challenged, validated, and (if invalid) rectified. The contract handles two distinct types of collateral with different lifecycles and responsibilities.

For the economic model and equilibrium analysis, see [deception](deception.md). For the collateral structure and trust module, see [trust](trust.md).

---

## Two Types of Collateral

Every block's initial FOR collateral covers two components:

### 1. Verifier Reward

The publisher's stake for short-term validity. It is high initially and decays exponentially back to the publisher over time (hours to days). The **original publisher remains responsible** for responding to challenges against this collateral -- it is never transferred to an aggregator.

If the block is valid and unchallenged, the full amount returns to the publisher. If the block is found invalid, the decayed remainder goes to the challenger.

### 2. Rectification Insurance

Long-term insurance for invalid blocks discovered later. Aggregators are responsible for rectification -- even if the original publisher is long gone, the current aggregator covers the cost. The aggregation fee (`throughput / AVG(throughput) * verification_cost`) funds this.

If an invalid block is discovered, the rectification pot pays:
- A **finder's reward** to whoever proved the invalidity.
- **Victim restoration** -- new outputs that make the incorrectly claimed outputs whole.

---

## The Challenge/Response Mechanism

Challenges serve dual purpose: they are both a verification mechanism and a data query mechanism. Requesting a hash preimage from a block IS verifying that block.

### Posting a Challenge (AGAINST)

Any peer can post a small AGAINST bond targeting a specific hash referenced by a block. The hash can be any structural commitment: a ref, an anchor, an aggregate hash, an output hash, or any other hash the block declares.

```
AGAINST output:
  verifier: { contract: COLLATERAL_RESOLUTION, params: encode(target_block, hash) }
  value: <small_bond>
```

The bond must be large enough to incentivize a response. If no one responds, the bond is too small. The protocol does not set a minimum -- the market determines what's worth responding to.

### Responding (Preimage Reveal)

Anyone who knows the preimage can claim the AGAINST bond by publishing a resolution block containing the preimage. The resolution contract verifies `hash(preimage) == hash` and awards the AGAINST bond to the responder.

```
Resolution block:
  claims: [AGAINST_output]
  outputs: [responder_payment]
  detail: encode(preimage)
```

This is self-resolving -- no dispute module, no voting. The hash either matches or it doesn't.

### What Happens During the Challenge Window

While an AGAINST challenge exists and is unresolved:

1. **The target block is effectively invalid.** Its weight is reduced. Blocks building on it are at risk.
2. **The publisher's verifier reward (Type 1) decays toward the challenger** instead of back to the publisher.
3. **Anyone can respond** -- not just the original publisher. Because responding is profitable (you claim the AGAINST bond), any peer holding the data is incentivized to respond.

If the challenge remains unresolved (no one produces the preimage), the block stays invalid. The full remaining verifier reward goes to the challenger.

### Using Challenges as Queries

To traverse a subtree, a peer posts AGAINST on a hash they want to descend into. The block creator (or anyone with the data) responds with the preimage, earning the AGAINST bond. The querier gets the data they wanted. This makes graph traversal a paid protocol operation where data providers are compensated.

---

## Verifier Reward Lifecycle (Type 1)

### Decay Formula

The verifier reward decays from the block's creation time:

```
reward(t) = C1 * exp(-c * (now - block_timestamp))
```

Where:
- `C1` is the initial verifier reward collateral (proportional to throughput)
- `c` is the decay constant (~0.2-0.3 per second for a half-life of ~2-3 seconds)
- `now` is when the challenge is resolved (or when the remaining collateral is returned)

At `t = block_timestamp` (immediate challenge): full reward.
After a few seconds: reward drops significantly.
After minutes/hours: reward is negligible; remainder returns to publisher.

### Why Decay Matters

The decay incentivizes:
- **Fast responses**: If you know the data, respond immediately. Delay means the reward shrinks.
- **Fast detection**: If a block is invalid, challenge it immediately. The verifier reward is highest when the block is fresh.
- **No data hiding**: An attacker who hides data and reveals it later gets negligible reward because the decay has consumed most of the verifier reward by then.

### Responsibility

The original publisher remains responsible for Type 1 for the block's lifetime. They are incentivized to stay online and respond to queries because:
- Each response earns the AGAINST bond (profitable).
- Failure to respond means their Type 1 decays to the challenger (costly).

If the publisher goes offline and the data is well-known, anyone can respond on their behalf. The AGAINST bond is still profitable for the responder, and the publisher's collateral is protected.

---

## Rectification Lifecycle (Type 2)

### Who is Responsible

Aggregators. When an aggregator includes a block in their tree, they take on rectification responsibility for that block. This is the aggregator's core economic role: long-term insurance.

### Fee

The aggregation fee funds rectification coverage:

```
f_i = v * T_i / T_avg
```

Where `v` is verification cost, `T_i` is the block's throughput, and `T_avg` is the average throughput. This is a constant tax rate on throughput.

### When Rectification Triggers

Rectification requires:
1. A known block (not just a missing hash) whose Type 1 collateral has been resolved AGAINST -- i.e., the block is proven invalid.
2. A proof chain from the current aggregator through intermediate aggregators to the invalid block.

### Payout

The rectification pot (proportional to throughput T) is split:

1. **Finder's reward**: Paid to whoever proved the block invalid. This incentivizes discovery. The finder may be the original publisher themselves (self-flagging) or any third party.
2. **Victim restoration**: New outputs are created that mirror the incorrectly claimed outputs. For example, if an output to public key A was incorrectly claimed by B's forged signature, a new output to A is created, making A whole.

### Example

1. Block B has an output: 100 coins to pubkey A.
2. Fraudulent block F claims B's output using a forged signature for A.
3. F is aggregated. The aggregator now insures F.
4. B discovers F is fraudulent (B knows A's real signature wasn't used).
5. B posts AGAINST on F's signature hash. F's publisher can't respond (the preimage would prove the signature is forged).
6. F is resolved invalid. Type 1 decays to B (the challenger).
7. Rectification triggers: the aggregator's Type 2 pot pays a finder's reward to B and creates a new 100-coin output for A.

---

## Interaction Between Types

The two types are complementary:

| Property | Type 1 (Verifier Reward) | Type 2 (Rectification) |
|---|---|---|
| Who posts it | Publisher | Aggregator (funded by fee) |
| Who is responsible | Original publisher | Current aggregator chain |
| What it covers | Validity and structural correctness | Restoring incorrectly claimed outputs |
| Timescale | Seconds to hours (decaying) | Hours to weeks (persistent) |
| Claimed by | Challenger (AGAINST poster) | Finder + victim restoration |
| Transfers to aggregator? | No -- stays with publisher | Yes -- aggregator takes this risk |

A single invalid block resolution touches both:
1. Type 1 decays to the challenger who proved invalidity.
2. Type 2 pays the finder and restores victims.

---

## Initial Collateral Sizing

The publisher's initial FOR collateral must fund both components:

```
initial_FOR = C1 + f
```

Where:
- `C1` is the verifier reward component (proportional to throughput T, large enough to incentivize verification)
- `f` is the aggregation fee (throughput / AVG(throughput) * verification_cost)

`C1` should be large relative to `f` because it is the primary deterrent against publishing invalid blocks. The publisher risks losing `C1` if challenged. The aggregation fee `f` is comparatively small.

---

## Simplifications Over the Previous Model

This contract replaces several mechanisms from the earlier design:

1. **No voting.** The old FOR/AGAINST model used stake-weighted voting to determine validity. Hash challenges are self-resolving -- the hash matches or it doesn't. No dispute module needed for structural validity.
2. **No risk transfer of publisher collateral.** The publisher's Type 1 stays with them. Aggregators handle a separate Type 2 pot. This eliminates the complexity of transferring collateral between parties.
3. **No separate dispute module for hash challenges.** Computational validity (does the WASM produce the right output?) may still need a dispute mechanism. But structural validity (do the hashes match?) is deterministic.
4. **Queries and verification are the same operation.** No separate query/promise mechanism -- AGAINST challenges ARE queries, and responses ARE verification.

---

## Open Questions

1. **Decay constant c**: Needs calibration. Fast enough that data hiding is unprofitable (reward negligible after ~30s), slow enough that honest responses (~1-3s) earn most of the reward. c = 0.2-0.3 per second is a starting point.
2. **Minimum AGAINST bond**: The market should set this, but is there a risk of dust challenges being used to harass publishers? A minimum might be needed.
3. **Rectification proof chain**: What exactly does the proof chain look like? The aggregator must demonstrate they're responsible for the invalid block through their aggregation tree. This needs specification.
4. **Finder's reward fraction**: What fraction of the rectification pot goes to the finder vs. victim restoration? If the finder's reward is too small, nobody looks. If too large, victims aren't fully restored.
5. **Computational validity**: Hash challenges handle structural validity. How does this contract interact with challenges to computational correctness (WASM re-execution)? This likely still needs a dispute mechanism.

---

## Implementation

No implementation yet. This is a new contract that will need:

| File | Description |
|------|-------------|
| Future: `src/core/CollateralResolutionContract.ts` | The WASM contract logic |
| Future: `src/core/CollateralResolutionModule.ts` | Module wrapping challenge/response lifecycle |
| [`src/core/TrustModule.ts`](../../src/core/TrustModule.ts) | Updates to integrate two-tier model |
