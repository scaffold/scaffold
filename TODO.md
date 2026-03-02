# TODO

Queued protocol work, roughly in priority order. Each item follows the 4-step development sequence in AGENTS.md: document → skeleton → test → implement.

## Core Protocol

### Block Creation Module — skeleton, test, implement
Documented in `docs/protocol/block-creation.md`. Next steps: write the skeleton interfaces/classes in `src/`, write tests around draft lifecycle and block construction, then implement.

### Execution Module
Define what it means to execute a block. Deterministic WASM computation semantics, how work is declared, how inputs map to outputs, and what constitutes a valid execution. The consensus module references "validity/execution modules" as the source of direct conflict declarations.

### Verification Module
The bridge between sampling and execution. Sampling selects what to verify; this module defines how to check if declared work is real — the spot-check procedure, how to request and re-execute a unit of work, and how results feed back into the sampling module's success/failure tracking. Referenced by consensus, sampling, and trust.

### Reactive Strategy / Draft Generator System
The BlockCreationModule needs a mechanism for representing conditional intents that react to canonical state changes. Rather than static drafts with fixed input/output bindings, this likely requires draft generator functions that evaluate against the current canonical view and produce concrete drafts.

A strategy is a rule: "when the canonical state matches condition X, do action Y." Examples:
- "When subtrees S1, S2, S3 are all canonical and mature, aggregate them"
- "When my block B becomes non-canonical, republish from draft with new inputs"
- "When any output matching predicate P appears (e.g., incentivizing a computation we completed), claim it"
- "When block H has collateral FOR but no AGAINST, and I've verified it's invalid, challenge it"

Key design questions:
- How to represent conditions over canonical state efficiently — avoid re-evaluating all strategies on every state change. Probably needs a subscription/trigger model where strategies register interest in specific state transitions.
- How draft generators compose — can multiple generators contribute claims to the same block? This relates to draft merging/compatibility.
- Lifecycle: when are generators created? When do they expire? A generator for "aggregate subtrees X, Y, Z" should expire if those subtrees are aggregated by someone else.
- Interaction with anchor selection: a generator's condition may constrain the anchor (must be deep enough to see certain outputs). The anchor selection heuristic and the generator system need to cooperate.

This is closely related to the draft system in the BlockCreationModule but may deserve its own specification, since it's more about reactive scheduling than block construction mechanics.

### Dispute Module
Resolution mechanism for FOR/AGAINST collateral stakes. The trust module explicitly defers to this: given competing collateral placements, how is a winner determined? Defines the voting/evidence mechanism, evidence requirements, escalation, and how dispute outcomes flow back to the trust module for collateral redistribution.

## Infrastructure

### Peer Module
Peer discovery, connection management, and disconnection of useless peers. The gossip module exports per-peer quality scores and consumes the peer set + transport metrics (latency, throughput). This module decides who to connect to, how to find new peers, and when to drop unproductive connections.

### Request/Response Protocol
The client-facing request path. AGENTS.md describes "browser requests data or global state, peers compete to resolve first, and correct work is rewarded." No module currently specifies this flow: how a client submits a request, how peers race to respond, how the response is validated, and how the reward is distributed.

## Structural

### Block Header Schema
Formal unified specification of block structure. Currently scattered: consensus sees weight vectors and aggregates sets, conflict sees claim masks and output counts, gossip sees size, trust sees collateral references. Should be one canonical schema that all modules reference.

## Application Layer

These sit on top of the core protocol and can be specified later.

### Game State Contracts
Deterministic WASM execution for serverless game-state consensus. Dispute/penalty mechanics for incorrect state transitions.

### Content Distribution
Social content from peers with signatures and globally consistent latest-state resolution.

### Marketplace / Escrow
Decentralized marketplaces with escrow and protocol-level resolution/voting.
