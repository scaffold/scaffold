# 13 - Storage Manager

## Summary

StorageManager persists canonical blocks to the storage plugin and restores them on startup.

## Dependencies

- 00-folder-reorganization
- 02-reactive-layer

## Design

- StorageManager class in `src/node/StorageManager.ts`
- On construction: load blocks from storage, process each through reactive layer
- On canonicality change (via strategy or direct hook): persist newly canonical blocks
- On block becoming non-canonical: optionally remove from storage (or keep for faster re-canonicalization)
- Uses BlockSerializer for serialization

## Interface

```typescript
class StorageManager {
  constructor(plugin: StoragePlugin, reactive: ReactiveLayer)

  // Called during initialization
  restore(): Promise<void>

  // Called on canonicality changes
  persistBlock(block: Block): void
  removeBlock(hash: Hash): void
}
```

## Implementation Notes

- Storage namespace: 0 for blocks, 1 for metadata.
- On restore, blocks need to be processed in order (by depth/anchor chain). Sort by depth before processing.
- Use a "storage strategy" that reacts to canonicality changes and persists/removes blocks. Or hook directly into the reactive layer.

## Testing

- Test persist + restore round-trip.
- Test that restored blocks are processed through reactive layer.
