# 04 - FetchManager

## Summary

FetchManager tracks active fetch subscriptions, creates incentive blocks, deduplicates concurrent requests for the same verifier, and notifies subscribers when canonical results change.

## Dependencies

- 00-folder-reorganization
- 02-reactive-layer
- 06-put-manager

## Design

- FetchManager class in `src/node/FetchManager.ts`
- `fetch(verifier, options)` -> FetchHandle:
  1. Check if canonical result already exists -> immediate callback
  2. Create incentive block via PutManager (if no existing incentive)
  3. Register subscription keyed by verifier
  4. Return handle with close()
- Deduplication: multiple fetches for same verifier share one incentive and subscription
- FetchNotifyStrategy calls into FetchManager when canonicality changes affect a verifier
- Supports mode (fastest/strongest/latest), minCanonicality, debounceMs
- Debouncing: if timePlugin available, delay callbacks. If not, fire immediately.

## Interface

```typescript
class FetchManager {
  fetch(verifier: Verifier, options: FetchOptions): FetchHandle

  // Called by FetchNotifyStrategy
  notifyCanonicalityChange(changes: CanonicicalityChange[]): void

  // Called by close()
  closeAll(): void
}
```

## Implementation Notes

- Need a way to check if a block satisfies a verifier. This means matching block outputs against the verifier's contract hash and params. For now, a simple match on contract hash in outputs.
- Verifier -> string key for dedup (hash of contract + params)
- When the incentive block itself loses canonicality, may need to re-publish

## Testing

- Test fetch with immediate result
- Test fetch with delayed result
- Test dedup
- Test canonicality change notifications
- Test close()
