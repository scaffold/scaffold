# Scaffold

## Purpose
Scaffold is a browser-first protocol architecture that moves cloud responsibilities to clients and enables global consensus in the browser.

Primary feature:
- In-browser transparent microtransactions: a browser requests data or global state, peers compete to resolve first, and correct work is rewarded.

## High-Level Overview
Scaffold is intended to support:
- Serverless game-state consensus (deterministic WASM + dispute/penalty mechanics)
- Social content distribution from peers with signatures and globally consistent latest-state resolution
- Distributed database semantics
- Decentralized marketplaces with escrow and protocol-level resolution/voting

## Goals
1. Browser-native operation:
Use WASM, WebRTC, and WebSockets. Server-side implementations may exist for performance, but should not have privileged protocol capabilities.

2. Fast request/response that is usually correct:
The common-case request path should be faster than traditional server round trips, often requiring only one WebRTC P2P round trip with immediate trust signals (for example via collateral).

3. Economic pressure toward correctness:
Incorrect responses should be eventually corrected, and publishing incorrect responses should be economically disadvantageous. Risk-averse users should have safety-oriented operating modes.

4. Eventual immutability:
Executions are eventually committed to a global block graph. Finalization should be delayed enough to allow verifiers to detect and challenge incorrect executions.

## Philosophy
- The elegant, simple solution is always the right one.
- The protocol documentation is always the source of truth. The implementation is just an implementation.
- Scaffold is decentralized, so every action must be incentivized.

## Source ↔ Documentation Map

Each protocol module has a spec in `docs/protocol/` and an implementation in `src/core/`. Both directions are cross-linked. When adding, renaming, or removing modules or source files, update the links in both directions: the `// Protocol spec:` comment in the source file and the `## Implementation` table in the doc.

| Protocol Doc | Core Module | Service Adapter | Supporting Files |
|-------------|-------------|-----------------|-----------------|
| [overview.md](docs/protocol/overview.md) | — | — | [Coordinator.ts](src/core/Coordinator.ts), [ProtocolContext.ts](src/core/ProtocolContext.ts) |
| [consensus.md](docs/protocol/consensus.md) | [ConsensusModule.ts](src/core/ConsensusModule.ts) | [ConsensusService.ts](src/core/ConsensusService.ts) | |
| [conflict.md](docs/protocol/conflict.md) | [OutputClaimModule.ts](src/core/OutputClaimModule.ts) | [OutputClaimService.ts](src/core/OutputClaimService.ts) | |
| [sampling.md](docs/protocol/sampling.md) | [SamplingModule.ts](src/core/SamplingModule.ts) | [SamplingService.ts](src/core/SamplingService.ts) | |
| [trust.md](docs/protocol/trust.md) | [TrustModule.ts](src/core/TrustModule.ts) | [TrustService.ts](src/core/TrustService.ts) | |
| [gossip.md](docs/protocol/gossip.md) | [GossipModule.ts](src/node/GossipModule.ts) | [GossipService.ts](src/node/GossipService.ts) | |
| [block-creation.md](docs/protocol/block-creation.md) | [BlockCreationModule.ts](src/core/BlockCreationModule.ts) | [BlockCreationService.ts](src/core/BlockCreationService.ts) | [Block.ts](src/core/Block.ts) |
| [anchoring.md](docs/protocol/anchoring.md) | [AnchoringModule.ts](src/core/AnchoringModule.ts) | — | [OutputMapping.ts](src/core/OutputMapping.ts), [Block.ts](src/core/Block.ts) |
| [dag.md](docs/protocol/dag.md) | — (structural, spans modules) | — | [Block.ts](src/core/Block.ts), [ConsensusModule.ts](src/core/ConsensusModule.ts) |
| [weight.md](docs/protocol/weight.md) | — (design discussion) | — | [BlockCreationModule.ts](src/core/BlockCreationModule.ts), [ConsensusModule.ts](src/core/ConsensusModule.ts) |
| [output-data.md](docs/protocol/output-data.md) | — | — | [Contract.ts](src/contracts/Contract.ts), [RecordingWalkerHost.ts](src/core/RecordingWalkerHost.ts), [DefaultBuilderHost.ts](src/core/DefaultBuilderHost.ts) |
| [computation.md](docs/protocol/computation.md) | [ExecutionModule.ts](src/core/ExecutionModule.ts), [VerificationModule.ts](src/core/VerificationModule.ts) | [ExecutionService.ts](src/core/ExecutionService.ts), [VerificationService.ts](src/core/VerificationService.ts) | [ContractEnv.ts](src/core/ContractEnv.ts), [Contract.ts](src/contracts/Contract.ts), [VerifyingEnv.ts](src/core/VerifyingEnv.ts), [GeneratingEnv.ts](src/core/GeneratingEnv.ts), [ContractGenerator.ts](src/core/ContractGenerator.ts), [Block.ts](src/core/Block.ts), [WasmStore.ts](src/core/WasmStore.ts) |
| [deception.md](docs/protocol/deception.md) | — (not yet implemented) | — | |
| [collateral-resolution.md](docs/protocol/collateral-resolution.md) | [CollateralContract.ts](src/contracts/CollateralContract.ts), [InsuranceContract.ts](src/contracts/InsuranceContract.ts) | — | [ContractEnv.ts](src/core/ContractEnv.ts), [Block.ts](src/core/Block.ts) |
| [draft-blocks.md](docs/protocol/draft-blocks.md) | [DraftManager.ts](src/core/DraftManager.ts) | — | [BlockDraft.ts](src/core/BlockDraft.ts), [Generator.ts](src/core/Generator.ts) |
| [output-claims.md](docs/protocol/output-claims.md) | [OutputClaimModule.ts](src/core/OutputClaimModule.ts) | [OutputClaimService.ts](src/core/OutputClaimService.ts) | |
| [output-space.md](docs/protocol/output-space.md) | — (structural, spans modules) | — | [OutputSpace.ts](src/core/OutputSpace.ts), [Block.ts](src/core/Block.ts) |
| [aggregation.md](docs/protocol/aggregation.md) | — | — | [AggregationContract.ts](src/contracts/AggregationContract.ts), [Block.ts](src/core/Block.ts), [ContractGenerator.ts](src/core/ContractGenerator.ts) |
| [execution-queue.md](docs/protocol/execution-queue.md) | [ExecutionQueueModule.ts](src/core/ExecutionQueueModule.ts) | [ExecutionQueueService.ts](src/core/ExecutionQueueService.ts) | |

## Key Protocol Invariant: Outputs Before Claims

A block's **output space** is its final, post-claim set of surviving outputs -- the clean set that descendants inherit. During construction, the block's own outputs are prepended to the inherited (post-subtree) space, forming the **extended vector**. Claims are then applied as removals from this extended vector. This ordering enables self-claiming: a block can produce output at index 0 and claim index 0 in the same block. Claim indices in `block.claims` refer to positions in the extended vector, not in the final output space.

## Queued Work
See `TODO.md` for the current backlog of protocol modules and concepts to document and implement, roughly in priority order.

## Ways of Working
Planning -> Documentation -> Testing -> Coding

### Planning
- Iterate directly with Joel until assumptions and tradeoffs are explicit.
- Proactively raise missing constraints, attack surfaces, and ambiguous incentives.
- Notion may be used as historical reference (read-only), but can be stale.
- Write durable decisions in repo markdown, not in Notion.

### Documentation
- Protocol documentation is the highest-priority artifact.
- Maintain living docs with full ownership: add/update/delete as needed to keep docs aligned with intended protocol behavior.
- Target: docs should be sufficient for a conforming implementation without relying on undocumented assumptions.
- When adding a new module doc, update the module map in `docs/protocol/overview.md` to include it.

### Testing
- Favor state-machine and transition-based tests.
- Model node state + peer/user inputs -> output blocks and side effects.
- Use tests to lock in protocol invariants and regression boundaries before broad implementation.

### Coding
- Implement after protocol docs and tests define expected behavior.
- As much as possible, keep things very modular and encapsulated. Use providers to abstract away dependencies.
- For logical parts, don't use Context or assume anything about the BlockType except what you can access through the provider.
- Glue code using Context should be minimal; it's much more difficult to test.

## Logging and Debugging

Scaffold has a structured event logging system for debugging. See `.claude/skills/debug-browser.md` for the full debugging reference.

### Key components
- **`src/core/EventLog.ts`** -- Ring buffer event log with `ScopedLogger`. Queryable by system, event, block hash, level, and seq range.
- **`src/debug/ScaffoldDebug.ts`** -- Debug API exposed on `window.__scaffold` for browser DevTools introspection. Methods for querying blocks, consensus, conflicts, UTXOs, output space, and the event log.
- **`src/core/ProtocolContext.ts`** -- Provides `ctx.logger('system')` for any DI-constructed service.

### Instrumented systems
`coordinator` (block lifecycle, canonicality, conflicts, weight), `reactive` (strategy evaluation), `gossip` (push decisions, peer lifecycle, delivery), `network` (connections, block send/receive).

### Keeping instrumentation up to date
When adding a new module or service:
1. Get a logger via `ctx.logger('mymodule')` in the service constructor
2. Log state transitions at `info` level and decisions at `debug` level
3. Include block hashes in data so `__scaffold.history(prefix)` works
4. If the module has queryable state, add a method to `ScaffoldDebugAPI`

### Demo dev workflow
The demo app at `demo/` resolves `scaffold.io` imports directly to `src/` via Vite aliases. Changes are picked up instantly -- no npm rebuild needed for development.

## 4-Step Development Sequence
1. Build `docs/protocol/` as markdown documents covering protocol concepts and mechanics.
2. Write a skeleton in `src/core/`. Create the classes and interfaces you're going to need. If you're building a module, keep it very encapsulated, don't use any Context or assume anything about the BlockType except what you can access through the provider.
3. Write tests around protocol/state transition behavior. You can run them like this: `deno test --allow-all tests/ModuleName.test.ts`
4. Implement and iterate with documentation and tests as the controlling spec, until you're satisfied with your implementation.