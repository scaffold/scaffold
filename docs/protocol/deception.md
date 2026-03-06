# Strategic Deception (Future Consideration)

This document captures initial thoughts on incentivizing a baseline level of invalid block publication to sustain verification incentives. This is NOT a current protocol mechanism — it requires the dispute module and economic equilibrium analysis to be specified first.

---

## The Verification Incentive Problem

If no one publishes invalid blocks, verifiers earn nothing. If verifiers earn nothing, they stop verifying. If no one verifies, aggregators stop probing. If no one probes, fraud becomes costless.

A perfectly honest network has zero verification incentive, making it maximally vulnerable to the first attacker.

---

## The Deception Equilibrium

A healthier equilibrium involves a low baseline fraud rate:

1. Some nodes occasionally publish invalid blocks.
2. Verifiers catch them and earn rewards (collateral claims).
3. Aggregators probe at a calibrated rate to bound their fraud exposure.
4. The fraud rate stabilizes where: `P(caught) × collateral_lost ≈ P(not_caught) × target_aggregator_collateral`.

### Why Publish Invalid Blocks?

If you publish an invalid block and an aggregator incorporates it without verifying, you can contest the aggregator's collateral and win. The aggregator staked on the validity of your block (by aggregating it), and you know it's invalid.

- **If you succeed** (aggregator doesn't catch it): you claim their collateral.
- **If you fail** (caught before aggregation, or aggregator probes and rejects): you lose your own collateral.

This creates a natural adversarial dynamic that funds the verification layer.

### Nash Equilibrium

At equilibrium:
- Fraud rate is low but nonzero.
- Verification is marginally profitable.
- Aggregation probing depth is calibrated to the fraud rate.
- The cost of verification is funded by occasional fraud rewards.

If fraud rate drops to zero → verification becomes unprofitable → verifiers exit → fraud becomes profitable → fraud rate rises → equilibrium restores. The system is self-correcting.

### Engineering the Equilibrium

The protocol could encourage a healthy equilibrium by:
- Ensuring verification rewards are proportional to the collateral at stake.
- Making collateral requirements low enough that occasional loss is tolerable for strategic fraud.
- Possibly: an explicit "verification bounty" funded by a small tax on all blocks, ensuring verifiers are profitable even if the fraud rate drops very low. This acts as a floor on verification incentives.

---

## Implications for BlockCreationModule

In the future, the BlockCreationModule could support an optional deception strategy:
- Occasionally create drafts for structurally valid but computationally invalid blocks.
- Target aggregators that appear to be under-probing (low verification rates).
- Calibrate frequency based on expected value: `(reward × P(success)) - (collateral × P(failure))`.

This is a rational economic strategy, not an attack. It serves the network by maintaining verification pressure.

---

## Open Questions

1. **Target fraud rate**: What equilibrium fraud rate is healthy? Depends on collateral ratios and verification costs — requires the dispute module to be specified first.
2. **Explicit vs. emergent**: Should the protocol explicitly incentivize deception (e.g., through rewards for catching fraud), or just allow it and let the equilibrium emerge naturally?
3. **Reputation effects**: Nodes caught publishing invalid blocks may be deprioritized by peers in the gossip module. Does this create a secondary cost that suppresses the fraud rate below the healthy equilibrium?
4. **Spiral risk**: Could the fraud rate spiral upward? Likely self-limiting — higher fraud → more verification → more catching → lower fraud. But worth modeling formally.
5. **Verification cartels**: Can verifiers and publishers collude (publisher tips off verifier, they split the reward)? This may not be harmful — the collateral still gets claimed, and the verification still happens. The "victim" is the aggregator who should have probed more carefully.

---

## Implementation

No implementation yet — this is a future consideration pending the dispute module.
