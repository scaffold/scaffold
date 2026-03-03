# Plan: Dispute Strategy

## Summary

When verification reveals an invalid block, create a dispute block with AGAINST collateral targeting it. This is the enforcement mechanism that makes fraud expensive.

## Dependencies

- `02-reactive-layer` (strategy infrastructure)
- `07-contract-executor` (verification produces validity results)
- `06-put-manager` (creating dispute blocks)
- `14-sampling-strategy` (verification results trigger disputes)

## Design

DisputeStrategy in `src/node/strategies/DisputeStrategy.ts`.

On evaluate:
1. Check if any verification completed with a failure (block declared invalid)
2. For each invalid block: check if we already have an AGAINST collateral block for it
3. If not, and collateral feature is enabled: return a createBlock action for an AGAINST collateral block
4. The collateral block targets the invalid block, staking the minimum collateral amount

The dispute block is a regular block with:
- An output with the collateral contract
- A claim against the invalid block (to link the dispute)
- Data encoding the AGAINST vote and evidence (the mismatched output)

## Interface

```typescript
class DisputeStrategy implements Strategy {
  constructor(config: { enabled: boolean; collateralAmount: number })
  evaluate(event: ReactiveEvent): Action[]
}
```

## Implementation Notes

- Need a way to track which blocks have been verified as invalid. This could be state on the sampling module, or a separate set maintained by the reactive layer.
- The collateral contract and block structure need to be defined as part of the Dispute Module protocol spec (still in TODO). This strategy implements the *node behavior* for disputes; the protocol rules are separate.
- Collateral amount: use `config.economics.minimumCollateral(block.declaredWeight)`.
- Evidence: include the expected output (from our re-execution) vs the actual output. This lets other peers verify the dispute without re-executing.
- Start with a simple implementation: just create the AGAINST block. The full dispute resolution (voting, escalation, redistribution) comes with the Dispute Module.

## Testing

- Test that invalid verification triggers dispute block creation.
- Test that duplicate disputes are prevented.
- Test that disputes are not created when collateral feature is disabled.
- Test that dispute blocks contain correct evidence.
