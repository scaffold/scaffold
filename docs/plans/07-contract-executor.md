# 07 - ContractExecutor

## Summary

ContractExecutor runs JS contract functions registered in config, providing them with a ContractContext that gives access to inputs, params, emit, and request.

## Dependencies

- 00-folder-reorganization

## Design

- ContractExecutor class in `src/node/ContractExecutor.ts`
- `execute(contract, params, inputs)` -> Promise<ExecutionResult>:
  1. Look up contract hash in config.contracts
  2. If not found, return { ok: false, error: 'no implementation' }
  3. Create ContractContext with inputs, params, emit function
  4. Call contract function with context
  5. Collect emitted outputs
  6. Return { ok: true, outputs, weight }
- ContractContext implements the interface from client-interface.md
- `ctx.request(verifier)` -> resolves to the first canonical result for that verifier. If no result exists, this will block until one appears (or timeout).

## Interface

```typescript
class ContractExecutor {
  constructor(contracts: Record<string, ContractFn>, resolveVerifier: (v: Verifier) => Promise<Uint8Array>)

  execute(contractHash: Hash, params: Uint8Array, inputs: Uint8Array[]): Promise<ExecutionResult>

  canExecute(contractHash: Hash): boolean
}

interface ExecutionResult {
  ok: true; outputs: Output[]; weight: number
} | {
  ok: false; error: string
}
```

## Implementation Notes

- ctx.request() is where the computation DAG forms. The resolveVerifier callback is provided by the node and may trigger a nested fetch.
- Per the user's specification: if a requested verifier's canonical result later becomes non-canonical, the generation that depended on it should be cancelled and restarted. This means we need to track which verifier results each execution depends on.
- For now, ctx.request() does a simple lookup of canonical results. If none exists, it could either throw (fail the execution) or wait (block). Start with throwing and revisit.

## Testing

- Test basic contract execution
- Test emit
- Test request (with pre-seeded canonical result)
- Test error handling
