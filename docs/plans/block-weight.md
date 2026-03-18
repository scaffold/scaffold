# Plan: Block Weight

## Goal
Define how block weight is determined and verified, resolving the open design question in weight.md.

## What Exists
- `weight.md` discusses four options: contract-declared, economic (fee-based), collateral-backed, hybrid
- Blocks have `declaredWeight: number` — currently any value is accepted
- Consensus uses weight vectors for branch selection
- Sampling priority and verification incentives depend on weight
- BlockCreationModule validates throughput (inputs == outputs value) but not weight

## What Needs to Be Done

1. **Choose a weight model** — this is the core design decision
2. **Document the chosen model** in weight.md (replace discussion with spec)
3. **Implement weight validation** in BlockCreationModule or a new WeightModule
4. **Update consensus** if the weight model changes how weight vectors work
5. **Update trust** if collateral-backed weight is chosen

## Open Questions
See docs/questions.md — this requires Joel's design decision.
