# Plan: Query and Promise Mechanism

## Goal
Implement offline state semantics: promise outputs that commit to producing data, and query outputs that request specific data.

## What Exists
- Described in computation.md (query-and-promise-mechanism section)
- ContractEnv.fetch() already supports cross-block data reading
- FetchManager handles request/response for verifiers
- DraftManager handles draft lifecycle

## What Needs to Be Done

1. **Promise output type**: A new standard contract where the output commits to eventually producing data matching a verifier. The promise is fulfilled when a block claims it and provides the data.

2. **Query output type**: A standard contract output that requests data from a specific verifier. Weight reduction for unanswered queries incentivizes fulfillment.

3. **Weight reduction**: Blocks with unanswered queries have reduced effective weight. Integrate with consensus weight calculation.

4. **Draft integration**: When a contract calls `ctx.request()` during generation, create a query output. When the query is fulfilled, create a dependent block.

## Open Questions
See docs/questions.md — this is a design-phase feature with significant protocol implications.
