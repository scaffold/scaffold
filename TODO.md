# TODO

Queued protocol work, roughly in priority order. Each item follows the 4-step development sequence in AGENTS.md: document → skeleton → test → implement.

## Core Protocol

### Block Creation Module
Define how blocks are constructed: anchor selection, weight vector declaration, claim mask construction, output production, and aggregation (supersession). Every existing module references "block creation module" as a source of inputs but none defines it. This is the foundational schema that all other modules consume.

### Execution Module
Define what it means to execute a block. Deterministic WASM computation semantics, how work is declared, how inputs map to outputs, and what constitutes a valid execution. The consensus module references "validity/execution modules" as the source of direct conflict declarations.

### Verification Module
The bridge between sampling and execution. Sampling selects what to verify; this module defines how to check if declared work is real — the spot-check procedure, how to request and re-execute a unit of work, and how results feed back into the sampling module's success/failure tracking. Referenced by consensus, sampling, and trust.

### Dispute Module
Resolution mechanism for FOR/AGAINST collateral stakes. The trust module explicitly defers to this: given competing collateral placements, how is a winner determined? Defines the voting/evidence mechanism, evidence requirements, escalation, and how dispute outcomes flow back to the trust module for collateral redistribution.

## Infrastructure

### Peer Module
Peer discovery, connection management, and disconnection of useless peers. The gossip module exports per-peer quality scores and consumes the peer set + transport metrics (latency, throughput). This module decides who to connect to, how to find new peers, and when to drop unproductive connections.

### Request/Response Protocol
The client-facing request path. AGENTS.md describes "browser requests data or global state, peers compete to resolve first, and correct work is rewarded." No module currently specifies this flow: how a client submits a request, how peers race to respond, how the response is validated, and how the reward is distributed.

## Structural

### Block Header Schema
Formal unified specification of block structure. Currently scattered: consensus sees weight vectors and supersedes sets, conflict sees claim masks and output counts, gossip sees size, trust sees collateral references. Should be one canonical schema that all modules reference.

## Application Layer

These sit on top of the core protocol and can be specified later.

### Game State Contracts
Deterministic WASM execution for serverless game-state consensus. Dispute/penalty mechanics for incorrect state transitions.

### Content Distribution
Social content from peers with signatures and globally consistent latest-state resolution.

### Marketplace / Escrow
Decentralized marketplaces with escrow and protocol-level resolution/voting.
