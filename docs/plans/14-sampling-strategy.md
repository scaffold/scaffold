# 14 - Sampling Strategy

## Summary

When canonical blocks exist that haven't been verified, pick the highest-priority one (from sampling module) and verify it.

## Dependencies

- 02-reactive-layer
- 07-contract-executor

## Design

- SamplingStrategy in `src/node/strategies/SamplingStrategy.ts`
- On evaluate:
  1. Query sampling module for highest-priority unverified block
  2. If priority > minPriority and we can execute the contract:
     a. Return a 'verify' action
  3. Limit concurrent verifications to resource config
- Verification action (async):
  1. ContractExecutor.execute(contract, params, inputs)
  2. Compare output against block's actual output
  3. On match: sampling.recordSuccess(block)
  4. On mismatch: sampling.recordFailure(block), may trigger dispute

## Interface

```typescript
class SamplingStrategy implements Strategy {
  constructor(config: SamplingConfig, executor: ContractExecutor)
  evaluate(event: ReactiveEvent): Action[]
}
```

## Implementation Notes

- Track in-flight verifications to avoid duplicates.
- The sampling module already computes priorities. This strategy just checks if the top priority exceeds the threshold and we have resources.
- For now, "verify" means re-execute the contract and compare outputs. This requires knowing what inputs the original block used (stored in block.claims).

## Testing

- Test that high-priority blocks trigger verification.
- Test success/failure recording.
- Test resource limiting.
