# 15 - Garbage Collector

## Summary

When the block store exceeds maxBlocks, evict least-recently-used non-essential blocks.

## Dependencies

- 00-folder-reorganization

## Design

- GarbageCollector class in `src/node/GarbageCollector.ts`
- Tracks access time for each block (updated on get, blockReceived, fetch hit)
- When store size > maxBlocks: evict oldest blocks that are NOT:
  - Genesis
  - Part of the canonical chain
  - Have active fetch subscriptions
  - Are referenced by in-flight computations
- Runs periodically if timePlugin available, or on-demand after each blockReceived

## Interface

```typescript
class GarbageCollector {
  markAccessed(hash: Hash): void
  maybeCollect(): void
}
```

## Implementation Notes

- Simple LRU: Map preserves insertion order, re-insert on access.
- Protected set: canonical blocks + genesis are never evicted.
- Also need to remove evicted blocks from the protocol modules (conflict, consensus, gossip state). This may require adding a `removeBlock` method to modules, or just letting them hold stale references (since they store by hash, a missing block from the store is treated as unknown).

## Testing

- Test eviction when over limit.
- Test that canonical and genesis blocks are protected.
- Test access ordering.
