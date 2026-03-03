## Summary

NodeContext holds references to the ProtocolContext, all plugins, all managers (FetchManager, PutManager, NetworkManager, etc.), and the ReactiveLayer. It's the internal counterpart to ProtocolContext.

## Dependencies

- 00-folder-reorganization
- 02-reactive-layer

## Design

- NodeContext class in `src/node/NodeContext.ts`
- Created by Scaffold constructor from ScaffoldConfig
- Creates ProtocolContext (protocol modules)
- Creates ReactiveLayer with appropriate strategies based on feature config
- Holds plugin references
- Creates and initializes managers as needed (FetchManager, NetworkManager, StorageManager, etc.)
- Provides `processBlock(block, fromPeer)` which delegates to ReactiveLayer
- Provides `close()` for teardown

## Interface

```typescript
class NodeContext {
  readonly protocol: ProtocolContext
  readonly store: BlockStore
  readonly coordinator: Coordinator
  readonly reactive: ReactiveLayer
  readonly publicKey: Uint8Array

  // Managers (created lazily or eagerly based on config)
  readonly fetch: FetchManager
  readonly put: PutManager
  readonly network?: NetworkManager
  readonly storage?: StorageManager

  processBlock(block: Block, fromPeer: string | null): BlockReceivedResult
  close(): Promise<void>
}
```

## Implementation Notes

- Genesis block processed on construction.
- Plugin lifecycle: start on construction, stop on close.
- Storage restore on construction (async - blocks loaded from storage).
- Network bootstrap on construction (async - connect to bootstrap peers).

## Testing

Test construction with various plugin combinations. Test teardown.
