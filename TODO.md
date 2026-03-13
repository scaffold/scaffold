# TODO

Queued protocol work, roughly in priority order. Each item follows the 4-step development sequence in AGENTS.md: document → skeleton → test → implement.

## Core Protocol

### Block weight
How is the weight of a block determined and verified?

### ~~Execution Module~~ ✓
Implemented: `ExecutionModule.ts` with mock contract registry, `HostContext` host functions (setData, addOutput, requireSignature, cross-block refs), and `ExecutionService` adapter. See [computation.md](docs/protocol/computation.md).

### ~~Verification Module~~ ✓
Implemented: `VerificationModule.ts` bridges SamplingModule (selectNext) with ExecutionModule (verifyBlock), reporting results back to sampling. See [computation.md](docs/protocol/computation.md).

### ~~Dispute Module~~ ✓
Implemented: `DisputeModule.ts` resolves FOR/AGAINST collateral stakes using majority-by-stake with proportional payouts. See [computation.md](docs/protocol/computation.md).

### WASM Contract Runtime
The ExecutionModule currently uses a TypeScript mock contract registry. Replace with real `WebAssembly.instantiate` loading, host function bindings (imports), and memory management. The module interface stays the same — only the contract dispatch changes.

### Deception Module
Formalize the strategic deception equilibrium from [deception.md](docs/protocol/deception.md): insurance commitments on FOR collateral, self-catch mechanism for trap blocks, and calibrated fraud rates. Requires the dispute module (now done) and economic equilibrium analysis.

### Query and Promise Mechanism
Design the offline state mechanism from [computation.md](docs/protocol/computation.md#query-and-promise-mechanism): promise outputs committing to data, query outputs requesting specific data, and weight reduction for unanswered queries.

## Infrastructure

### Peer Module
Peer discovery, connection management, and disconnection of useless peers. The gossip module exports per-peer quality scores and consumes the peer set + transport metrics (latency, throughput). This module decides who to connect to, how to find new peers, and when to drop unproductive connections.

#### Request Routing (Open Problem)
How do incentive blocks reach peers who can fulfill them? Options to explore:

1. **Gossip-only**: Rely on gossip module's utility scoring to prioritize incentive blocks. Simple but may be slow if the network is large and the contract is niche.

2. **DHT-like sync points**: Hash the verifier's contract hash to a point in a DHT. Generators register interest at that point; clients route incentive blocks there. The sync point forwards to registered generators. Pros: efficient for niche contracts. Cons: adds infrastructure complexity, sync point is a soft centralization point.

3. **Subscription flooding**: Peers advertise which contracts they can execute (via peerInfo). Gossip module uses this as a relevance signal — incentive blocks for contract C are routed preferentially to peers advertising C. Pros: uses existing gossip infrastructure. Cons: floods subscription info.

4. **Hybrid**: Start with gossip-only. If gossip is too slow for niche contracts, layer on contract-interest advertisements in peerInfo. The gossip relevance scoring already has hooks for per-peer interest signals.

Likely best starting point: option 4 (gossip-only, with peerInfo contract interest as optimization).

## Structural

### ~~Block Header Schema~~ ✓
Addressed: the block wire format now carries only structural primitives (anchor, aggregates, claims, outputs, declaredWeight, creator, signature). Domain-specific data (aggregation state, collateral targets, payment targets) lives in contract outputs. See [contracts.md](docs/protocol/contracts.md) and [block-creation.md](docs/protocol/block-creation.md).

### ~~Output Schema Migration~~ ✓
Addressed: Output migrated from `{ contract, value, data }` to `{ verifier: { contract, params }, value, detail }`. Block gained `refs: Hash[]` for cross-block references. `SELF_CONTRACT` added for self-claimed key-value outputs. See [computation.md](docs/protocol/computation.md).

## Computation DAG

When a contract calls `ctx.request(otherVerifier)`, it resolves to a Promise for the first canonical response. This creates an input dependency: the generated block specifies the requested block as an input. If the requested result later becomes non-canonical, the dependent block is affected — generation should be cancelled (if still running) and restarted with the new canonical input.

Key design questions:
- How deep can the computation DAG go? Contracts requesting contracts requesting contracts... Need to bound recursion depth.
- How does `ctx.request()` interact with the reactive layer? If the requested verifier has no canonical result, should the execution wait (potentially forever), fail, or trigger a nested fetch?
- Cycle detection: contract A requests B, B requests A. Must be detected and reported as an error.
- Caching: if the same verifier is requested by multiple contracts, the result should be computed once. The fetch deduplication in FetchManager may handle this naturally.

## Application Layer

These sit on top of the core protocol and can be specified later.

### Game State Contracts
Deterministic WASM execution for serverless game-state consensus. Dispute/penalty mechanics for incorrect state transitions. The ExecutionModule's HostContext already supports the full host function interface needed (setData, addOutput, cross-block refs).

### Content Distribution
Social content from peers with signatures and globally consistent latest-state resolution.

### Marketplace / Escrow
Decentralized marketplaces with escrow and protocol-level resolution/voting.
