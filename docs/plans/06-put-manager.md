# 06 - PutManager

## Summary

PutManager creates blocks from PutRequest, signs them, and submits them through the reactive layer.

## Dependencies

- 00-folder-reorganization
- 02-reactive-layer

## Design

- PutManager class in `src/node/PutManager.ts`
- `put(request)` -> PutResult:
  1. Build BlockSpec from request (outputs, claims, weight)
  2. Build block via BlockCreationService
  3. Create block via createBlock()
  4. Sign block (using private key from config)
  5. Process through ReactiveLayer.processBlock()
  6. Return { hash }
- For `satisfies` option: find the incentive block's output and set up claims
- For basic put (no satisfies): just create an output with the data

## Interface

```typescript
class PutManager {
  put(request: PutRequest): PutResult
}
```

## Implementation Notes

- The "sign" step is secp256k1 signing - pure crypto, no plugin needed
- For `satisfies`, need to find the canonical incentive block for the verifier and claim its output. This requires scanning the block store.
- The default contract for data outputs needs to be defined (a simple "data" contract hash)

## Testing

- Test basic put
- Test put with satisfies
- Test that put block goes through reactive layer
