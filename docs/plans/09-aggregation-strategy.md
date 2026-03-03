# 09 - AggregationStrategy

## Summary

When canonical leaves share an anchor and haven't been aggregated, build an aggregation block.

## Dependencies

- 02-reactive-layer
- 06-put-manager

## Design

- AggregationStrategy in `src/node/strategies/AggregationStrategy.ts`
- On evaluate:
  1. Get canonical view from consensus
  2. Group canonical blocks by anchor
  3. For each anchor group: filter to non-aggregated leaf blocks
  4. If group has >= minLeaves blocks (default 2):
    a. Select up to maxChildren blocks (default 3)
    b. Build aggregation BlockSpec (anchor = shared anchor, aggregates = selected blocks)
    c. Return createBlock action
- Replaces the current `attemptAggregation()` method on Coordinator

## Interface

```typescript
class AggregationStrategy implements Strategy {
  constructor(config: AggregationConfig)
  evaluate(event: ReactiveEvent): Action[]
}
```

## Implementation Notes

- Only evaluate when there are canonicality changes (skip if result.canonicalityChanges is empty)
- The "estimate we can win the race" heuristic is deferred for now. Start with always attempting aggregation when conditions are met.
- Should not re-aggregate blocks that were aggregated in the current evaluation cycle (recursion guard)
- The aggregation block needs at least one output. This could be a "fee" output going to the aggregator.

## Testing

- Test that 2+ canonical leaves at same anchor triggers aggregation
- Test that already-aggregated leaves are skipped
- Test maxChildren limit
- Test that aggregation blocks themselves are not re-aggregated immediately
