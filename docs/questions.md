# Open Questions

Questions that need answers before implementation can proceed. Grouped by plan.

## Block Weight

1. **Which weight model?** The four options in weight.md are: (A) contract-declared (trust the contract to set weight honestly), (B) economic (weight = fees paid), (C) collateral-backed (weight = collateral posted), (D) hybrid. Which direction are you leaning? This affects almost everything downstream -- collateral posting, deception equilibrium, generator behavior.

2. **Is weight a protocol invariant or a convention?** Should the protocol reject blocks with "invalid" weight, or should it accept any declared weight and let economic incentives punish liars?

## Collateral Posting

3. **Auto-post or manual?** Should the CollateralStrategy automatically post FOR collateral on every block we generate, or should it be opt-in per contract type? For example: always post on hard contracts, never on easy contracts (signatures)?

4. **How much to stake?** Is the stake amount a fixed multiple of the block's declared weight, a percentage of the output values, or something else? The deception equilibrium analysis in deception.md parameterizes this as C (collateral) but doesn't specify how C is derived.

5. **Redemption timing**: The collateral lifecycle says "redeem after aggregation." Should the strategy proactively scan for redeemable collateral, or react to aggregation events?

## WASM Runtime

6. **WASM ABI**: What calling convention should WASM contracts use? Options: (A) WASI-like with fd_read/fd_write for data passing, (B) custom import/export with shared linear memory, (C) component model. The ContractEnv methods need to be callable from WASM -- how are complex types (Verifier, Input, Output) serialized across the boundary?

7. **Async in WASM**: ContractFn returns `MaybePromise<void>`. WASM is synchronous. If a contract calls `fetch()` or `collectInputs()` (which may be async in generation mode), how does the WASM contract suspend? Options: (A) asyncify transform, (B) require all generation-mode operations to be sync, (C) run WASM in a worker with message passing.

## Generator

8. **Cancellation model**: When a draft is cancelled mid-generation (canonicality change), how should the running contract be aborted? WASM doesn't support cooperative cancellation natively. Options: (A) let it finish and discard the result, (B) terminate the WASM instance, (C) use a cancellation flag checked at host function boundaries.

9. **Concurrent generation**: GenerationStrategy has `maxConcurrent: 3`. Should each concurrent generation get its own GeneratingEnv and run independently, or should they share state (e.g., a shared UTXO view)?

## Contracts

10. **Timelock -- how to access anchor depth?** The timelock contract needs to verify `anchor chain depth >= minDepth`. ContractEnv doesn't expose anchor chain access. Options: (A) add `getAnchorDepth(): number` to ContractEnv, (B) add a more general `getBlockMetadata()` method, (C) encode depth in block fields. Which approach?

11. **Collateral contract port -- which parts to keep?** The old CollateralContract uses `requireTimestampGte()` and `compareBlockOrder()` which don't exist on the new ContractEnv. Should we add these methods to ContractEnv, or redesign the collateral contract to not need them?

12. **Legacy contracts -- which are still needed?** The contracts in `src/contracts/` predate the current module system. Which should be ported to the new ContractFn/ContractEnv interface? Candidates: AccountContract, DataContract, TimeContract, FrontierContract, BurnContract. Are any of these superseded by the new standard contracts?

## Network Wiring

13. **Where does NetworkManager live?** Options: (A) owned by Scaffold (alongside PutManager, FetchManager), (B) owned by NodeContext (alongside protocol services), (C) separate from both, passed in as config. Scaffold seems right since it's the user-facing API, but NodeContext is where the coordinator lives.

14. **BlockAwareness implementation for real peers**: SimNode tests use SetAwareness (simple Set). For real peers, should we use: (A) same Set (simple, unbounded memory), (B) bloom filter (space-efficient, false positives OK), (C) something else?

15. **WebRTC signaling**: WebrtcProvider handles negotiation but needs a signaling channel. Is the WebSocket server the intended signaling path (connect via WS first, then upgrade to WebRTC)?

## Deception Module

16. **When to implement?** The deception module depends on the weight model, collateral posting strategy, and economic parameter choices. Should this wait until those are resolved, or can the module skeleton be built now with pluggable parameters?

## Computation DAG

17. **Recursion depth limit**: What's a reasonable maximum? The spec mentions bounding it but doesn't give a number. Is 3 levels enough, or do we need more for real applications?

18. **Blocking vs non-blocking requests**: When contract A calls `request(B)` and B has no canonical result, should generation of A: (A) block until B is resolved (potentially forever), (B) fail immediately and retry later, (C) trigger nested generation of B and wait?
