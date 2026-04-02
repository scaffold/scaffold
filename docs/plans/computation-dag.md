# Plan: Computation DAG

## Goal
Support contracts that depend on other contracts' results via `ctx.request()`.

## What Exists
- ContractExecutor (node layer) has `request(contractHash, params)` in ContractContext
- FetchManager handles request/response subscriptions
- DraftManager cancels drafts when canonicality changes

## What Needs to Be Done

1. **Dependency tracking**: When contract A calls `request(B)`, record the dependency. If B's canonical result changes, invalidate A's result.

2. **Recursive generation**: If B has no canonical result when A requests it, trigger generation of B. This creates a dependency chain.

3. **Cycle detection**: A→B→A must be detected and rejected.

4. **Depth limits**: Bound maximum recursion depth.

5. **Caching**: Deduplicate identical requests across contracts.

## Open Questions
See docs/questions.md — all of the key design questions from TODO.md apply.
