# Plan: Deception Module

## Goal
Implement the strategic deception equilibrium from deception.md: insurance commitments, self-flagging, and calibrated fraud rates.

## What Exists
- `deception.md` — complete game-theoretic specification with parameters, equilibrium analysis, and mechanism design
- TrustModule — tracks collateral, computes encapsulated weight
- DisputeModule — resolves disputes, computes payouts
- CollateralSide (For/Against), CollateralStatus lifecycle

## What Needs to Be Done

1. **Insurance commitment tracking**: When a publisher posts FOR collateral, they may also commit to an insurance multiplier. Track this commitment alongside the collateral placement.

2. **Self-catch mechanism**: A publisher who posts an invalid block can later flag it themselves to claim a share of the aggregator's collateral. Need a `selfFlag(blockHash)` method that the publisher calls to reveal invalidity.

3. **Fraud rate calibration**: The equilibrium fraud rate depends on verification cost, collateral amount, and insurance multiplier. Implement the formula from deception.md to compute the expected optimal fraud rate.

4. **Trap block detection**: Aggregators should detect trap blocks (blocks intentionally invalid to bait self-flagging) via sampling. Wire into SamplingStrategy.

## Open Questions
See docs/questions.md — this is heavily dependent on the weight model and collateral posting design.
