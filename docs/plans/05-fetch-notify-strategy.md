# 05 - FetchNotifyStrategy

## Summary

On every canonicality change, check if any active fetch subscription is affected and notify it.

## Dependencies

- 02-reactive-layer
- 04-fetch-manager

## Design

- FetchNotifyStrategy in `src/node/strategies/FetchNotifyStrategy.ts`
- On evaluate: look at canonicality changes, for each changed block check if it satisfies any active fetch verifier
- If a block satisfying verifier V becomes canonical -> notify FetchManager
- If a block satisfying verifier V becomes non-canonical -> notify FetchManager (may need to find new canonical result or send null)
- Returns notifyFetch actions

## Interface

```typescript
class FetchNotifyStrategy implements Strategy {
  evaluate(event: ReactiveEvent): Action[]
}
```

## Implementation Notes

- Needs access to FetchManager's active subscription set
- For efficiency, maintain a reverse index: contract hash -> list of active fetches
- The actual callback invocation happens in FetchManager, not in the strategy

## Testing

- Test that canonicality changes trigger fetch notifications
- Test that losing canonicality sends null
