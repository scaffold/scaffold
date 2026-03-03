# 08 - GenerationStrategy

## Summary

When an incentive block becomes canonical and we have the contract implementation, execute the contract and publish the response.

## Dependencies

- 02-reactive-layer
- 07-contract-executor
- 06-put-manager

## Design

- GenerationStrategy in `src/node/strategies/GenerationStrategy.ts`
- On evaluate:
  1. For each newly canonical block, check if it's an incentive (has output with known incentive contract)
  2. Check if we have a contract implementation for the requested verifier
  3. Check if a canonical response already exists
  4. Check resource availability (concurrent job limit)
  5. If all checks pass, return a 'generate' action
- The action is executed asynchronously:
  1. ContractExecutor.execute(contract, params, inputs)
  2. On success: PutManager.put({ data: result, satisfies: verifier })
  3. On failure: log and move on
- Track in-flight generations to avoid duplicate work
- If the incentive block loses canonicality while generating, cancel the generation

## Interface

```typescript
class GenerationStrategy implements Strategy {
  evaluate(event: ReactiveEvent): Action[]
}
```

## Implementation Notes

- In-flight tracking: Map<verifierKey, AbortController>
- When incentive loses canonicality: abort the in-flight generation
- Per user's specification: if ctx.request() resolves to a value that later becomes non-canonical, the entire generation should be cancelled and restarted. The AbortController approach handles this.
- Need to define what an "incentive block" looks like structurally. For now: a block with an output whose contract is INCENTIVE_CONTRACT_HASH and whose data encodes the requested verifier.
- Resource limiting: check NodeContext's resource tracker before starting

## Testing

- Test that incentive block triggers generation
- Test that existing response prevents re-generation
- Test cancellation on canonicality loss
- Test resource limiting
