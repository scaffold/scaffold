# TODO

Queued protocol work, roughly in priority order. Each item follows the 4-step development sequence in AGENTS.md: document → skeleton → test → implement.

## Core Protocol

### Block weight
How is the weight of a block determined and verified?

### Execution Module
Define what it means to execute a block. Deterministic WASM computation semantics, how work is declared, how inputs map to outputs, and what constitutes a valid execution. The consensus module references "validity/execution modules" as the source of direct conflict declarations.

### Verification Module
The bridge between sampling and execution. Sampling selects what to verify; this module defines how to check if declared work is real — the spot-check procedure, how to request and re-execute a unit of work, and how results feed back into the sampling module's success/failure tracking. Referenced by consensus, sampling, and trust.

### Dispute Module
Resolution mechanism for FOR/AGAINST collateral stakes. The trust module explicitly defers to this: given competing collateral placements, how is a winner determined? Defines the voting/evidence mechanism, evidence requirements, escalation, and how dispute outcomes flow back to the trust module for collateral redistribution.

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
Deterministic WASM execution for serverless game-state consensus. Dispute/penalty mechanics for incorrect state transitions.

### Content Distribution
Social content from peers with signatures and globally consistent latest-state resolution.

### Marketplace / Escrow
Decentralized marketplaces with escrow and protocol-level resolution/voting.
