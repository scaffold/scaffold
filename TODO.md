# TODO

Queued protocol work, roughly in priority order. Each item follows the 4-step development sequence in AGENTS.md: document → skeleton → test → implement.

## Core Protocol

### Collateral Posting Strategy
The TrustModule tracks collateral and the DisputeStrategy emits `dispute` actions for invalid blocks, but there is no strategy for **posting** collateral. Need a `CollateralStrategy` that:
- Posts FOR collateral on blocks we generated (publisher obligation for hard contracts)
- Posts FOR collateral on blocks we verified as valid (earn resolution reward)
- Posts AGAINST collateral when verification fails (trigger dispute)
- Manages collateral lifecycle: redemption after aggregation, reclaim when non-canonical

The reactive action types (`createBlock` with collateral outputs) exist, but the decision logic for when and how much to stake is unimplemented. The [CollateralContract](src/contracts/CollateralContract.ts) handles resolution; this is about the posting side.

### WASM Contract Runtime
The ExecutionModule currently uses a TypeScript mock contract registry. Replace with real `WebAssembly.instantiate` loading, host function bindings (imports), and memory management. The module interface stays the same -- only the contract dispatch changes. The [WasmStore](src/core/WasmStore.ts) exists as an in-memory binary store but is not yet consumed for actual WASM execution.

### Generator Implementation
[Generator.ts](src/core/Generator.ts) is a `StubGenerator` that records generate/cancel signals without performing real computation. Replace with a real generator that:
- Runs contracts in generation mode via [GeneratingEnv](src/core/GeneratingEnv.ts)
- Produces block specs from [ContractGenerator](src/core/ContractGenerator.ts) draft pipeline
- Handles async WASM execution
- Cancels running generations when canonicality changes invalidate the draft

The [GenerationStrategy](src/node/strategies/GenerationStrategy.ts) already detects incentive blocks and emits `createBlock` actions, but the actual contract execution is stubbed.

### Deception Module
Formalize the strategic deception equilibrium from [deception.md](docs/protocol/deception.md): insurance commitments on FOR collateral, self-catch mechanism for trap blocks, and calibrated fraud rates. Requires the dispute module (done) and economic equilibrium analysis. No core module exists yet.

### Query and Promise Mechanism
Design the offline state mechanism from [computation.md](docs/protocol/computation.md#query-and-promise-mechanism): promise outputs committing to data, query outputs requesting specific data, and weight reduction for unanswered queries. A scoping plan lives at [docs/plans/query-promise.md](docs/plans/query-promise.md).

## Contracts

Standard contracts are specified in [contracts.md](docs/protocol/contracts.md). Implementation status:

| Contract | Spec | Implementation | Status |
|----------|------|----------------|--------|
| Signature | contracts.md | [SignatureContract.ts](src/contracts/SignatureContract.ts) | Done |
| Aggregation | contracts.md | [AggregationContract.ts](src/contracts/AggregationContract.ts) | Done (threshold-based, uses `requireInput`) |
| Collateral | contracts.md | [CollateralContract.ts](src/contracts/CollateralContract.ts) | Done |
| Insurance | collateral-resolution.md | [InsuranceContract.ts](src/contracts/InsuranceContract.ts) | Done |
| Record | contracts.md | [RecordContract.ts](src/contracts/RecordContract.ts) | Done (self-claim enforced via `collectInputs().isSelfClaim`) |
| Timelock | contracts.md | — | Needs implementation (verify anchor chain depth >= minDepth in params) |
| Computation | contracts.md | ExecutionModule mock registry | Working for TypeScript mocks; needs WASM runtime for real contracts |

## Infrastructure

### Storage Plugin Wiring
[StorageManager](src/node/StorageManager.ts) defines the plugin interface and load/save semantics, but it is not instantiated from `Scaffold`. Existing plugins that still need to be wired:
- [DenoKvStorageProvider](plugins/deno/DenoKvStorageProvider.ts) -- Deno KV backend
- [OpfsStorageProvider](plugins/browser/OpfsStorageProvider.ts) -- browser OPFS
- [LocalStorageProvider](plugins/browser/LocalStorageProvider.ts) -- browser localStorage
- [NullStorageProvider](plugins/NullStorageProvider.ts) -- ephemeral fallback

Specific work: add a `storage?` config field to `Scaffold`, construct `StorageManager` when provided, replay persisted blocks through the coordinator on startup, and persist new canonical blocks.

### Peer Module
Peer discovery, connection management, and disconnection of useless peers. The gossip module exports per-peer quality scores and consumes the peer set + transport metrics (latency, throughput). This module decides who to connect to, how to find new peers, and when to drop unproductive connections.

#### Request Routing (Open Problem)
How do incentive blocks reach peers who can fulfill them? Options to explore:

1. **Gossip-only**: Rely on gossip module's utility scoring to prioritize incentive blocks. Simple but may be slow if the network is large and the contract is niche.

2. **DHT-like sync points**: Hash the verifier's contract hash to a point in a DHT. Generators register interest at that point; clients route incentive blocks there. The sync point forwards to registered generators. Pros: efficient for niche contracts. Cons: adds infrastructure complexity, sync point is a soft centralization point.

3. **Subscription flooding**: Peers advertise which contracts they can execute (via peerInfo). Gossip module uses this as a relevance signal -- incentive blocks for contract C are routed preferentially to peers advertising C. Pros: uses existing gossip infrastructure. Cons: floods subscription info.

4. **Hybrid**: Start with gossip-only. If gossip is too slow for niche contracts, layer on contract-interest advertisements in peerInfo. The gossip relevance scoring already has hooks for per-peer interest signals.

Likely best starting point: option 4 (gossip-only, with peerInfo contract interest as optimization).

## Computation DAG

When a contract calls `ctx.request(otherVerifier)`, it resolves to a Promise for the first canonical response. This creates an input dependency: the generated block specifies the requested block as an input. If the requested result later becomes non-canonical, the dependent block is affected -- generation should be cancelled (if still running) and restarted with the new canonical input.

Key design questions:
- How deep can the computation DAG go? Contracts requesting contracts requesting contracts... Need to bound recursion depth.
- How does `ctx.request()` interact with the reactive layer? If the requested verifier has no canonical result, should the execution wait (potentially forever), fail, or trigger a nested fetch?
- Cycle detection: contract A requests B, B requests A. Must be detected and reported as an error.
- Caching: if the same verifier is requested by multiple contracts, the result should be computed once. The fetch deduplication in FetchManager may handle this naturally.

## Application Layer

These sit on top of the core protocol and can be specified later.

### Game State Contracts
Deterministic WASM execution for serverless game-state consensus. Dispute/penalty mechanics for incorrect state transitions. The ContractEnv interface (VerifyingEnv/GeneratingEnv) supports the full host function interface needed (requireResult, requireOutput, fetch, collectInputs).

### Content Distribution
Social content from peers with signatures and globally consistent latest-state resolution.

### Marketplace / Escrow
Decentralized marketplaces with escrow and protocol-level resolution/voting.
