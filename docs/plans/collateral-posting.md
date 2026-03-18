# Plan: Collateral Posting Strategy

## Goal
Implement a `CollateralStrategy` that automatically posts FOR and AGAINST collateral based on block generation and verification results.

## What Exists
- TrustModule tracks collateral placements (addCollateral, redeemCollateral, reclaimCollateral)
- DisputeStrategy emits `dispute` actions when invalid blocks are detected
- DisputeModule resolves disputes and computes payouts
- CollateralContract (src/contracts/) handles resolution from the old codebase
- COLLATERAL_CONTRACT hash defined in Block.ts
- ReactiveLayer action types: `createBlock` (can include collateral outputs), `dispute`

## What Needs to Be Done

1. **New `CollateralStrategy` implementing Strategy interface** with these behaviors:
   - **Post-generation FOR**: After we create a block (detected via `fromPeer === null` and block source is Local), post FOR collateral if the block claims hard-contract outputs
   - **Post-verification FOR**: After successful verification (sampling result), post FOR collateral on the verified tree to earn resolution reward
   - **Post-verification AGAINST**: After failed verification, post AGAINST collateral to trigger dispute
   - **Lifecycle management**: Track active placements, attempt redemption after aggregation, reclaim when non-canonical

2. **Collateral block construction**: A collateral posting is itself a block with a COLLATERAL_CONTRACT output. The strategy needs to emit `createBlock` actions with the right outputs and claims.

3. **Configuration**: `minStakeAmount`, `maxExposure`, `autoPostOnGeneration`, `autoPostOnVerification`

4. **Wire into NodeContext** alongside existing strategies

## Open Questions
See docs/questions.md — depends on weight model and economic parameters.
