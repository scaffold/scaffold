## Summary

The reactive layer evaluates strategy handlers after every blockReceived() call. Strategies inspect canonicality changes and protocol state, then return actions. Actions are executed, potentially creating new blocks that trigger more evaluations.

## Dependencies

- 00-folder-reorganization

## Design

- ReactiveLayer class in `src/node/ReactiveLayer.ts`
- Holds a list of Strategy instances
- Main method: `processBlock(block, fromPeer)`:
  1. Call coordinator.blockReceived(block, fromPeer) -> get result
  2. For each strategy: actions = strategy.evaluate(event)
  3. Execute actions (create blocks, start verification, notify fetches)
  4. Block creation actions recurse through processBlock (bounded: a strategy should not fire on blocks it just created in the same evaluation cycle)
- Strategies are registered at construction time based on feature config

## Interface

```typescript
interface Strategy {
  evaluate(event: ReactiveEvent): Action[]
}

interface ReactiveEvent {
  block: Block
  fromPeer: string | null
  result: BlockReceivedResult
  store: BlockStore
  consensus: ConsensusService
  conflict: ConflictService
  sampling: SamplingService
}

type Action =
  | { type: 'createBlock'; spec: BlockSpec; sign: boolean }
  | { type: 'verify'; block: Hash; contract: Hash; params: Uint8Array }
  | { type: 'dispute'; block: Hash; side: 'for' | 'against' }
  | { type: 'notifyFetch'; verifier: VerifierKey; result: FetchResult | null }
```

## Implementation Notes

- Recursion guard: track which block hashes were created in current evaluation cycle. Don't pass them to strategies (or strategies should filter them out).
- Actions that are async (verify, generate) are started but don't block the evaluation loop. Their results come back as new blocks later.
- The reactive layer is the ONLY thing that calls coordinator.blockReceived(). Network receives, put(), etc. all go through the reactive layer.

## Testing

Test with mock strategies that record calls. Test recursion bounding. Test that canonicality changes from strategy-created blocks trigger further evaluation.
