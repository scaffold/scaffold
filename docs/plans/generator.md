# Plan: Generator Implementation

## Goal
Replace StubGenerator with a real generator that runs contracts in generation mode to produce blocks.

## What Exists
- `GeneratorProvider` interface: `generate(draft: BlockDraft) → GeneratorHandle`
- `StubGenerator`: records signals, no computation
- `GeneratingEnv`: full generation-mode ContractEnv implementation (collectInputs, requireInput, requireOutput, requireResult, fetch — all build up the draft)
- `ContractGenerator`: wires GeneratingEnv into the draft pipeline, produces BlockSpec from draft + contract execution
- `GenerationStrategy`: detects incentive blocks, emits `createBlock` actions
- `DraftManager`: manages draft lifecycle, cancellation on canonicality changes

## What Needs to Be Done

1. **Implement `ContractDrivenGenerator` implementing GeneratorProvider**:
   - `generate(draft)`: look up the contract for the draft's target verifier, create a GeneratingEnv, run the contract, extract outputs/claims/refs from the env, compose a BlockSpec
   - Support both sync and async contract execution (ContractFn returns MaybePromise)
   - Return a GeneratorHandle with working `cancel()` (abort the async execution)

2. **Wire into NodeContext**: Replace StubGenerator with ContractDrivenGenerator in NodeContext constructor

3. **Error handling**: If generation fails (contract throws, no inputs available), cancel the draft gracefully via DraftManager

4. **Tests**: Test generation with mock contracts, verify draft → block flow

## Open Questions
See docs/questions.md — async cancellation model, concurrent generation limits.
