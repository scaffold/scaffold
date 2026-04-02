# Plan: Standard Contract Implementations

## Goal
Implement the remaining standard contracts from contracts.md and evaluate legacy contracts.

## Signature Contract
See `signature-contract.md` — separate plan, implementable now.

## Timelock Contract

**What it does**: Output spendable only after anchor chain depth >= minDepth.

**What's needed**:
- A ContractEnv method to query anchor chain depth, or a way for the contract to walk the chain
- Currently ContractEnv has no anchor chain access — the contract can't count depth
- Options: (a) add `getAnchorDepth(): number` to ContractEnv, (b) encode depth in block metadata, (c) use block timestamps as a proxy

**Open questions**: See docs/questions.md — needs ContractEnv extension decision.

## Collateral Contract Port

**What exists**: `src/contracts/CollateralContract.ts` using old `ContractProvider<Hash>` / `ComputationDriver` interface.

**What's needed**:
- Port to new `ContractFn` / `ContractEnv` interface
- The old contract uses `driver.collectInputs()`, `driver.requireOutput()`, `driver.requireTimestampGte()`, `driver.compareBlockOrder()`, `driver.fail()` — most map to ContractEnv methods
- `requireTimestampGte` and `compareBlockOrder` don't exist on ContractEnv yet

**Open questions**: See docs/questions.md — needs ContractEnv timestamp/ordering extensions.

## Legacy Contract Review

Contracts in `src/contracts/` using old interface:
- `AccountContract.ts` — balance management (likely still needed)
- `DataContract.ts` — data storage (likely still needed)
- `TimeContract.ts` — timestamp verification (likely needed, similar to timelock)
- `FrontierContract.ts` — frontier voting (protocol-level, likely needed)
- `BurnContract.ts` — asset destruction (useful utility)
- `CollatzContract.ts` — demo computation (keep as example)
- `GeneratorContract.ts` — output generation (may overlap with new Generator)
- `TrueContract.ts` — always accept (keep as test utility)
- `NameContract.ts` — named output tracking (application-level)
- `RootContract.ts` — root authority (application-level)

**What's needed**: Review each, decide keep/port/remove, port the keepers to ContractFn/ContractEnv.

**Open questions**: See docs/questions.md — which contracts are still relevant?
