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
| [routing.md](docs/protocol/routing.md) | [RoutingModule.ts](src/node/RoutingModule.ts) | [RoutingService.ts](src/node/RoutingService.ts) | |
| [transport.md](docs/protocol/transport.md) | — | [TransportManager.ts](src/node/TransportManager.ts), [SignalingService.ts](src/node/SignalingService.ts), [NetworkBridge.ts](src/node/NetworkBridge.ts) | [transport.ts](src/interfaces/transport.ts), [PeerConnection.ts](src/node/PeerConnection.ts) |
| [wire-format.md](docs/protocol/wire-format.md) | — | — | [Atom.ts](src/core/Atom.ts), [Packet.ts](src/core/Packet.ts), [PacketSerializer.ts](src/core/PacketSerializer.ts), [Block.ts](src/core/Block.ts), [SignalAtom.ts](src/core/SignalAtom.ts), [RequestAtom.ts](src/core/RequestAtom.ts), [BlockSerializer.ts](src/core/BlockSerializer.ts) |
| [block-creation.md](docs/protocol/block-creation.md) | [BlockBuilderModule.ts](src/core/BlockBuilderModule.ts), [DraftManager.ts](src/core/DraftManager.ts) | — | [Block.ts](src/core/Block.ts), [PutManager.ts](src/node/PutManager.ts), [SendManager.ts](src/node/SendManager.ts), [AutoBalance.ts](src/node/AutoBalance.ts), [BlockCreationModule.ts](src/core/BlockCreationModule.ts) (legacy spec validator, slated for removal) |
| [anchoring.md](docs/protocol/anchoring.md) | [AnchoringModule.ts](src/core/AnchoringModule.ts) | — | [OutputMapping.ts](src/core/OutputMapping.ts), [Block.ts](src/core/Block.ts) |
| [placement.md](docs/protocol/placement.md) | [PlacementModule.ts](src/core/PlacementModule.ts) | [PlacementService.ts](src/core/PlacementService.ts) | [DraftPlacement.ts](src/core/DraftPlacement.ts), [ConsensusModule.ts](src/core/ConsensusModule.ts) (`getCanonicalAggregator`) |
| [dag.md](docs/protocol/dag.md) | — (structural, spans modules) | — | [Block.ts](src/core/Block.ts), [ConsensusModule.ts](src/core/ConsensusModule.ts) |
| [weight.md](docs/protocol/weight.md) | — (design discussion) | — | [BlockCreationModule.ts](src/core/BlockCreationModule.ts), [ConsensusModule.ts](src/core/ConsensusModule.ts) |
| [weight-propagation.md](docs/protocol/weight-propagation.md) | [NodeWeightsModule.ts](src/core/NodeWeightsModule.ts) | [NodeWeightsService.ts](src/core/NodeWeightsService.ts) | |
| [output-data.md](docs/protocol/output-data.md) | — | — | [Contract.ts](src/contracts/Contract.ts), [RecordingWalkerHost.ts](src/core/RecordingWalkerHost.ts), [DefaultBuilderHost.ts](src/core/DefaultBuilderHost.ts) |
| [computation.md](docs/protocol/computation.md) | [ContractVerificationModule.ts](src/core/ContractVerificationModule.ts), [BlockVerificationModule.ts](src/core/BlockVerificationModule.ts) | [ContractVerificationService.ts](src/core/ContractVerificationService.ts), [BlockVerificationService.ts](src/core/BlockVerificationService.ts) | [ContractHost.ts](src/core/ContractHost.ts), [ContractEnv.ts](src/core/ContractEnv.ts), [Contract.ts](src/contracts/Contract.ts), [VerifyingEnv.ts](src/core/VerifyingEnv.ts), [GeneratingEnv.ts](src/core/GeneratingEnv.ts), [Block.ts](src/core/Block.ts), [WasmStore.ts](src/core/WasmStore.ts) |
| [wasm-abi.md](docs/protocol/wasm-abi.md) | [WasmContractPlugin.ts](src/plugins/wasm/WasmContractPlugin.ts), [WasmExecutor.ts](src/plugins/wasm/WasmExecutor.ts), [WasmTransport.ts](src/plugins/wasm/WasmTransport.ts), [WasmHostBridge.ts](src/plugins/wasm/WasmHostBridge.ts), [WasmWireCodec.ts](src/plugins/wasm/WasmWireCodec.ts), [WasmWorkerPool.ts](src/plugins/wasm/WasmWorkerPool.ts), [WasmModules.ts](src/plugins/wasm/WasmModules.ts) | [InProcessMockTransport.ts](src/plugins/wasm/transports/InProcessMockTransport.ts), [JspiTransport.ts](src/plugins/wasm/transports/JspiTransport.ts), [AtomicsWorkerTransport.ts](src/plugins/wasm/transports/AtomicsWorkerTransport.ts) | [ContractPlugin.ts](src/core/ContractPlugin.ts), [ContractHost.ts](src/core/ContractHost.ts), [HashContract.ts](src/contracts/HashContract.ts), [WasmWorkerChannel.ts](src/worker/wasm/WasmWorkerChannel.ts), [wasmInstance.ts](src/worker/wasm/wasmInstance.ts), [wasmWorker.ts](src/worker/wasm/wasmWorker.ts), [wasmWorkerTypes.ts](src/worker/wasm/wasmWorkerTypes.ts), [ContractEnv.ts](src/core/ContractEnv.ts), [Contract.ts](src/contracts/Contract.ts), [WasmStore.ts](src/core/WasmStore.ts) |
| [deception.md](docs/protocol/deception.md) | — (not yet implemented) | — | |
| [collateral-resolution.md](docs/protocol/collateral-resolution.md) | [CollateralContract.ts](src/contracts/CollateralContract.ts), [InsuranceContract.ts](src/contracts/InsuranceContract.ts) | — | [ContractEnv.ts](src/core/ContractEnv.ts), [Block.ts](src/core/Block.ts) |
| [design/trust-gate.md](docs/design/trust-gate.md) | [TrustGate.ts](src/node/TrustGate.ts), [CollateralResolutionIndex.ts](src/node/CollateralResolutionIndex.ts) | [TrustGateService.ts](src/node/TrustGateService.ts), [CollateralResolutionIndexService.ts](src/node/CollateralResolutionIndexService.ts) | [TrustErrors.ts](src/node/TrustErrors.ts), [CollateralContract.ts](src/contracts/CollateralContract.ts) (verdict record output) |
| [design/piggyback.md](docs/design/piggyback.md) | [PiggybackStrategy.ts](src/node/strategies/PiggybackStrategy.ts) | — | [ReactiveLayer.ts](src/node/ReactiveLayer.ts) (`createBlock { broadcast }`, `submitBlock`, `dispatchActions`) |
| [design/wasi-shim.md](docs/design/wasi-shim.md), [design/wasi-shim-decisions.md](docs/design/wasi-shim-decisions.md) | [src/contracts/wasi-shim/](src/contracts/wasi-shim/) (Zig-built `wasi-shim.wasm`) | [setup.ts](src/contracts/wasi-shim/setup.ts) | [README.md](src/contracts/wasi-shim/README.md), [tests/WasiShim.test.ts](tests/WasiShim.test.ts), [tests/WasiShimQuickJS.test.ts](tests/WasiShimQuickJS.test.ts), [tests/WasiShimSetup.test.ts](tests/WasiShimSetup.test.ts), [tests/helpers/contractSnapshot.ts](tests/helpers/contractSnapshot.ts), [scripts/vendor_quickjs.ts](scripts/vendor_quickjs.ts) |
| [wasm-abi.md](docs/protocol/wasm-abi.md) (`scaffold_builder`/`scaffold_walker`) | [src/contracts/json-wb/](src/contracts/json-wb/) (Zig-built `json-wb.wasm`, generic JSON params/data codec) | — | [NestedBuilderHost.ts](src/core/NestedBuilderHost.ts), [DefaultBuilderHost.ts](src/core/DefaultBuilderHost.ts), [tests/JsonWb.test.ts](tests/JsonWb.test.ts) |
| (JS compile usage; compiler is out-of-bundle) | [JsCompilerContract.ts](src/contracts/JsCompilerContract.ts) (excluded from npm build), [src/contracts/js-runtime/](src/contracts/js-runtime/) | hosts register it: [compilerHashes.ts](demo/src/dev-demo/compilerHashes.ts) (`registerJsCompiler`), [tests/helpers/jsCompiler.ts](tests/helpers/jsCompiler.ts) | [wellKnown.ts](src/wellKnown.ts) (Deno-only, excluded from npm build), [well-known-blocks/](well-known-blocks/), [tests/JsCompiler.test.ts](tests/JsCompiler.test.ts), [tests/JsRuntime.test.ts](tests/JsRuntime.test.ts), [tests/ParamsCodec.test.ts](tests/ParamsCodec.test.ts) |
| [demo/chess.md](docs/demo/chess.md) | [GameStateContract.ts](src/contracts/GameStateContract.ts) | [ChessGame.ts](src/demo/chess/ChessGame.ts) | [ChessRules.ts](src/demo/chess/ChessRules.ts), [GameStateCodec.ts](src/demo/chess/GameStateCodec.ts) |
| [draft-blocks.md](docs/protocol/draft-blocks.md) | [DraftManager.ts](src/core/DraftManager.ts), [BlockBuilderModule.ts](src/core/BlockBuilderModule.ts), [GenerationModule.ts](src/node/GenerationModule.ts) | [GenerationService.ts](src/node/GenerationService.ts) | [Draft.ts](src/core/Draft.ts), [Generator.ts](src/core/Generator.ts), [PutManager.ts](src/node/PutManager.ts), [SendManager.ts](src/node/SendManager.ts) |
| [output-claims.md](docs/protocol/output-claims.md) | [OutputClaimModule.ts](src/core/OutputClaimModule.ts) | [OutputClaimService.ts](src/core/OutputClaimService.ts) | |
| [output-space.md](docs/protocol/output-space.md) | — (structural, spans modules) | — | [OutputSpace.ts](src/core/OutputSpace.ts), [Block.ts](src/core/Block.ts) |
| [aggregation.md](docs/protocol/aggregation.md) | — | — | [AggregationContract.ts](src/contracts/AggregationContract.ts), [Block.ts](src/core/Block.ts), [GenerationModule.ts](src/node/GenerationModule.ts) |
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
- `null` vs `undefined`: use `?` / `undefined` for "not provided / optional" (parameters, optional properties, unset config). Use `null` for the explicit "lookup or computation produced no result" return (e.g. `Hash | null`, `Block | null`). Don't mix the two for the same concept in one API.

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

### Think Before Coding
**Don't assume. Don't hide confusion. Surface tradeoffs.**
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### Never drop errors silently
Any path that catches an exception, drops a malformed input, or silently rejects a request SHOULD emit a log event. Default to `warn` for anything unexpected from outside the node (malformed peer input, failed connections, rejected handshakes) and `debug` for internal conditions that are expected but worth tracing (duplicate messages, deduplication hits, fallback paths). A silent `try { ... } catch { }` or `if (!valid) return;` without a log makes production debugging much harder later -- the cost of adding the log is trivial compared to the cost of not having it when you need it.

### Demo dev workflow
The demo app at `demo/` resolves `scaffold.io` imports directly to `src/` via Vite aliases. Changes are picked up instantly -- no npm rebuild needed for development.

## Never Hack Around Bugs or Gaps

If a bug, missing feature, or design gap is preventing you from completing a task or making a test pass, **stop and ask Joel for direction**. Do NOT silently work around it, weaken an assertion, skip the problematic path, or paper over the symptom. A failing test that documents a real gap is more valuable than a passing test that hides a bug we could have fixed.

When you hit a gap, surface it explicitly and offer the options. Joel may want to:
- Mark the test as `ignore` if we aren't going to fix it soon.
- Accept a failing test that will pass later when we address the issue.
- Hack a fix for now and document a future TODO to clean it up.
- Pause the main task so Joel can address the gap in another session, then resume work with it fixed.

In every case where you find a gap or bug -- whether you work around it under direction, ignore the test, or pause -- **notify Joel and add an entry to `TODO.md`**. You have absolute freedom (and are expected) to autonomously add things you discover to `TODO.md`. There should be no unreported gaps or bugs that Claude saw and worked around.

This is a team effort and Joel depends on you. Always strive for quality. If you see something, say something.

## 4-Step Development Sequence
1. Build `docs/protocol/` as markdown documents covering protocol concepts and mechanics.
2. Write a skeleton in `src/core/`. Create the classes and interfaces you're going to need. If you're building a module, keep it very encapsulated, don't use any Context or assume anything about the BlockType except what you can access through the provider.
3. Write tests around protocol/state transition behavior. You can run them like this: `deno test --allow-all tests/ModuleName.test.ts`
4. Implement and iterate with documentation and tests as the controlling spec, until you're satisfied with your implementation.
