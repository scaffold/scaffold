# Implementation Plan

How to get from the current state to the client interface described in `docs/client-interface.md`.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Scaffold (public API: fetch, put, close, context)   │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│  Reactive Layer                                      │
│  Evaluates rules on every canonicality change.       │
│  Produces actions: create blocks, verify, dispute.   │
│  Rules: Aggregation, Generation, Sampling,           │
│         Verification, Dispute                        │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│  Coordinator (pure event processor)                  │
│  blockReceived → conflict → consensus → gossip →     │
│  sampling → canonicality diff → return changes       │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│  Protocol Modules (pure, provider-interface-based)   │
│  BlockCreation, Conflict, Consensus, Gossip,         │
│  Sampling, Trust                                     │
└──────────────────────────────────────────────────────┘
         ▲                              ▲
         │                              │
    ┌────┘                              └────┐
    │                                        │
┌───▼──────────┐                    ┌────────▼─────┐
│  Block Store │                    │  Plugins     │
│  (in-memory) │                    │  (injected)  │
└──────────────┘                    └──────────────┘
```

**Key invariant:** The Coordinator and all protocol modules are pure. They process blocks and return results. They never call setTimeout, send network messages, or write to storage. All side effects flow through the reactive layer, which uses plugins.

## 1. Reactive Layer

This is the central new piece that doesn't exist yet. It replaces `attemptAggregation` on Coordinator and all the autonomous behaviors scattered across the old services.

### Design

The reactive layer is a set of **strategy handlers** that run after every `coordinator.blockReceived()` call. Each handler inspects the canonicality changes and protocol state, then returns zero or more **actions**.

```typescript
interface Strategy {
  /**
   * Evaluate this strategy against the latest state change.
   * Returns actions to take (create blocks, start verification, etc.)
   */
  evaluate(event: ReactiveEvent): Action[]
}

type ReactiveEvent = {
  result: BlockReceivedResult           // from Coordinator
  store: BlockStore
  consensus: ConsensusService
  conflict: ConflictService
  sampling: SamplingService
}

type Action =
  | { type: 'createBlock'; spec: BlockSpec; sign: boolean }
  | { type: 'verify'; block: Hash; contract: Hash }
  | { type: 'dispute'; block: Hash; side: 'for' | 'against' }
  | { type: 'gossip'; block: Hash; targets: string[] }
```

The reactive loop:

```
blockReceived(block)
  → result = coordinator.blockReceived(block)
  → for each strategy:
      actions = strategy.evaluate({ result, store, ... })
      for each action:
        execute(action)  // may create new blocks → recurse
```

Recursion is bounded: a strategy cannot fire on blocks it just created (prevent infinite loops). In practice, aggregation creates a block → that block triggers canonicality changes → but the aggregated leaves are no longer unaggregated, so the aggregation rule doesn't re-fire.

### Strategy: Aggregation

```
WHEN:  canonical leaf blocks L1..LN share an anchor AND N >= minLeaves
       AND no canonical aggregation of L1..LN exists
       AND we have resources
       AND we estimate we can win the aggregation race
THEN:  build aggregation block anchored at their shared anchor, aggregate L1..LN
```

The "estimate we can win" heuristic considers: how many peers are connected, how long ago the leaves became canonical (if long ago, someone else probably already aggregated), and our compute/bandwidth capacity.

When canonicality changes, the strategy re-evaluates. If a leaf loses canonicality (reorg), it drops out of the candidate set. If an aggregation block loses canonicality, the leaves become candidates again.

### Strategy: Generation

```
WHEN:  incentive block I is canonical
       AND I contains an output for verifier V
       AND no canonical response block for V exists
       AND we have a contract implementation for V.contract
       AND we have resources
THEN:  execute contract V.contract with V.params
       on success: put({ data: result, satisfies: V })
```

This replaces the old OrchestrationService's generation path. The execution itself is async (contract may be slow), so the action is "start generation" and the result is processed when it completes (which may be after further state changes — check if still needed before publishing).

### Strategy: Sampling & Verification

```
WHEN:  block B is canonical
       AND sampling.priority(B) > minPriority
       AND B is not yet verified by us
       AND we have the contract implementation for B
       AND we have resources
THEN:  re-execute B's contract, compare output
       on match:  sampling.recordSuccess(B)
       on mismatch: sampling.recordFailure(B), trigger dispute
```

### Strategy: Dispute

```
WHEN:  we verified block B as invalid
       AND no AGAINST collateral exists for B from us
THEN:  create dispute block with AGAINST collateral targeting B
```

### Strategy: Fetch Monitoring

Not a strategy per se, but the reactive layer also notifies active fetch subscriptions when canonicality changes affect their verifier. This replaces the 100ms polling in the old FetchService.

```
WHEN:  canonicality change affects block B
       AND B satisfies verifier V
       AND there's an active fetch for V
THEN:  call fetch.onResult with updated result (or null if lost)
```

### Execution

Actions are executed by the reactive layer using plugins:

- `createBlock`: build via BlockCreationService → sign → coordinator.blockReceived → gossip via network plugin
- `verify`: look up contract in config.contracts → execute → record result
- `dispute`: build collateral block → sign → coordinator.blockReceived → gossip
- `gossip`: serialize block → send via network plugin to specified peers

## 2. Plugin Integration

### How plugins wire in

The `Scaffold` constructor:

1. Creates `ProtocolContext` (protocol modules — pure)
2. Creates `NodeContext` (holds plugins + protocol context)
3. Processes genesis block through coordinator
4. Starts network plugins → they call `driver.onConnection()` when peers connect
5. Connects to bootstrap peers
6. If `timePlugin` provided: starts background behaviors via setInterval
   - Gossip tick (check for blocks to push)
   - GC tick (evict old blocks if over limit)
   - Peer discovery tick (find new peers if below target)

### Network integration

When a network plugin establishes a connection:

1. Library wraps it in a `PeerConnection` (handles serialization, framing, splitting)
2. Adds peer to gossip module
3. Syncs: sends our canonical chain summary, receives theirs
4. On received block data: deserialize → coordinator.blockReceived → reactive layer

When the reactive layer produces gossip actions:

1. Serialize block
2. Look up target peers
3. Send via `TransportConnection.sendReliable()`

### Storage integration

On every new canonical block (if storage plugin provided):

1. Serialize block
2. `storagePlugin.set(BLOCK_NAMESPACE, hash, serialized)`

On startup (if storage plugin provided):

1. `storagePlugin.list(BLOCK_NAMESPACE)` → deserialize each → coordinator.blockReceived

### Time integration

If `timePlugin` provided, the library schedules:

- Aggregation evaluation: on canonicality change (synchronous, no timer needed)
- Gossip push cycle: periodic (e.g. 100ms)
- GC: periodic (e.g. 10s)
- Peer maintenance: periodic (e.g. 60s)

If no `timePlugin`, the library is purely reactive — it only does work when `fetch`, `put`, or a peer message arrives. This is ideal for testing with explicit time advancement.

## 3. Networking Layer

### What to build vs extract

The old networking code has useful patterns but is tightly coupled to FactService. Build a new networking layer that:

**Extract from old code (the transport mechanics):**
- `MessageSplitter` / `MessageJoiner` from `src/util/MessageSplitter.ts` — MTU fragmentation
- Signal ordering from `plugins/util.ts` — async signal deduplication
- WebRTC negotiation patterns from `plugins/browser/WebrtcProvider.ts`
- WebSocket transport from `plugins/WebsocketClientProvider.ts` / `WebsocketServerProvider.ts`

**Build new (the protocol integration):**
- `PeerConnection` class wrapping `TransportConnection` with block serialization
- Sync protocol: exchange canonical chain summaries on connect
- Block request/response: request specific blocks by hash
- Peer discovery: exchange peer lists

**Don't extract (FactService-coupled routing):**
- `RoutingService` / `RoutingService2` — fact-centric routing logic
- `FactEmitter` — random sampling of facts for emission
- `Connection.ts` — too coupled to FactService/IngestionProvider

### Plugin assessment

The old plugins are close to what we need:

| Plugin | Reusable? | Notes |
|--------|-----------|-------|
| `WebsocketClientProvider` | **Yes, with minor changes** | Clean WebSocket transport. Change from SignalingDriver to NetworkDriver interface. |
| `WebsocketServerProvider` | **Yes, with minor changes** | Same — adapt interface. |
| `WebrtcProvider` | **Yes, needs work** | Complex but well-isolated. The ICE/signaling logic is reusable. Needs new signaling path (currently uses FactService for signal exchange). |
| `MockNetworkProvider` | **Yes, excellent** | Already pure. Simulated latency, packet loss. Perfect for testing. |
| `NullStorageProvider` | **Yes, as-is** | Trivial no-op. |
| `LocalStorageProvider` | **Yes, as-is** | Change Hash to Uint8Array in interface. |
| `OpfsStorageProvider` | **Yes, as-is** | Same. |
| `DenoKvStorageProvider` | **Yes, as-is** | Same. |
| `SeededEntropyProvider` | **Yes, as-is** | Already pure. |
| `ConsoleLoggingProvider` | **Yes, simplify** | Remove Context dependency. |
| `WebsocketLoggingProvider` | **Yes, simplify** | Remove Context dependency. |

**Bottom line:** Storage plugins are almost drop-in. Network plugins need interface adaptation but the transport logic is sound. The mock network is excellent.

## 4. Contract Execution

### Before WASM

Contracts are JS functions registered in `config.contracts`. The library provides a `ContractContext` that exposes inputs, params, and an emit function.

Execution flow:
1. Strategy decides to execute contract C with params P
2. Library creates `ContractContext` with inputs from canonical chain
3. Calls `config.contracts[C.hash](context)`
4. Collects emitted outputs
5. Creates block with those outputs

### WASM (future)

The worker system (`src/worker/`) is well-isolated and reusable:
- `Instance.ts` — WASM instantiation with custom imports
- `WasiImpl.ts` — WASI syscall shims
- `WorkerChannel.ts` — SharedArrayBuffer RPC
- `execJob.ts` — Job execution

These can be extracted as a `WasmPlugin` that implements the same `ContractFn` interface but delegates to a Worker pool. From the library's perspective, JS and WASM contracts are identical — just async functions.

## 5. Block Serialization

The current `BlockSerializer.ts` uses JSON with tagged types (Hash, Uint8Array, BigInt, BitVector). This is fine for now.

For production, we'll want a compact binary format. The old `protocol/base.ts` Avro system is well-built and could be adapted. But this is an optimization, not a blocker.

The serialization path:
- **Internal:** `Block` objects in memory (as-is)
- **Storage:** `serialize(block)` → bytes → `storagePlugin.set()`
- **Network:** `serialize(block)` → bytes → `connection.sendReliable()`
- **Hashing:** deterministic hash from block fields (already in `createBlock`)

## 6. What Exists vs What Needs to Be Built

### Exists (in core/ after reorganization)

| Component | Status | Notes |
|-----------|--------|-------|
| Block, BlockStore, createBlock | **Done** | Concrete types, factory functions |
| BlockCreationModule/Service | **Done** | Block construction from specs |
| ConflictModule/Service | **Done** | Conflict detection via claim masks |
| ConsensusModule/Service | **Done** | Canonical view computation |
| GossipModule/Service | **Done** | Push-based distribution logic |
| SamplingModule/Service | **Done** | Verification priority (Beta distributions) |
| TrustModule/Service | **Done** | Collateral tracking |
| Coordinator | **Done** | Two-event orchestrator |
| BitVector | **Done** | Chunked bit vectors with partial knowledge |
| BlockSerializer | **Done** | JSON serialization |
| ProtocolContext | **Done** | DI container for modules |
| BaseContext | **Done** | Generic DI container |
| util/* | **Done** | Hash, secp, data structures |

### Needs to be built

| Component | Priority | Effort | Description |
|-----------|----------|--------|-------------|
| **Scaffold** (new) | P0 | Small | Public API facade: fetch, put, close, context |
| **ReactiveLayer** | P0 | Medium | Strategy evaluation loop, action execution |
| **NodeContext** | P0 | Small | Holds plugins + protocol, wires everything |
| **FetchManager** | P0 | Medium | Manages active fetch subscriptions, incentive blocks, dedup |
| **PutManager** | P0 | Small | Creates and processes put blocks |
| **AggregationStrategy** | P1 | Small | Reactive aggregation rule |
| **GenerationStrategy** | P1 | Medium | Reactive generation (execute contracts on incentive) |
| **SamplingStrategy** | P1 | Medium | Reactive verification scheduling |
| **DisputeStrategy** | P2 | Small | Reactive dispute on verification failure |
| **PeerConnection** | P1 | Medium | Block serialization, sync, request/response over transport |
| **NetworkManager** | P1 | Medium | Plugin lifecycle, bootstrap, peer discovery |
| **StorageManager** | P1 | Small | Persist/restore blocks via storage plugin |
| **ContractExecutor** | P1 | Medium | Execute JS contracts with ContractContext |
| **GossipRouter** | P1 | Medium | Translate gossip module push actions → network sends |
| **GarbageCollector** | P2 | Small | LRU eviction when over maxBlocks |
| **Config validation** | P2 | Small | Validate ScaffoldConfig on construction |

### Modules still needed (from TODO.md)

These are protocol-level modules (pure, provider-interface-based) that extend the core:

| Module | Priority | Notes |
|--------|----------|-------|
| Execution Module | P1 | What constitutes valid execution, input→output mapping |
| Verification Module | P1 | Spot-check procedure, re-execution |
| Dispute Module | P2 | FOR/AGAINST resolution, evidence |
| Peer Module | P2 | Discovery, quality scoring, disconnection heuristics |

## 7. Folder Structure

```
src/
  Scaffold.ts                  # Public API (fetch, put, close, context)

  core/                        # Pure protocol modules
    Block.ts                     # Block interface, BlockStore, factories
    BitVector.ts                 # Chunked bit vector
    BlockCreationModule.ts
    ConflictModule.ts
    ConsensusModule.ts
    GossipModule.ts
    SamplingModule.ts
    TrustModule.ts
    BlockCreationService.ts      # Module adapters (wire to BlockStore)
    ConflictService.ts
    ConsensusService.ts
    GossipService.ts
    SamplingService.ts
    TrustService.ts
    Coordinator.ts               # Two-event orchestrator (pure)
    ProtocolContext.ts
    BlockSerializer.ts

  node/                        # Internal wiring (uses plugins)
    NodeContext.ts               # Holds plugins + protocol + managers
    ReactiveLayer.ts             # Strategy evaluation loop
    FetchManager.ts              # Active fetch subscription management
    PutManager.ts                # Block creation for put()
    ContractExecutor.ts          # JS contract execution with ContractContext
    strategies/
      AggregationStrategy.ts
      GenerationStrategy.ts
      SamplingStrategy.ts
      DisputeStrategy.ts
      FetchNotifyStrategy.ts     # Notify fetch subscriptions on changes
    NetworkManager.ts            # Plugin lifecycle, bootstrap, peer routing
    PeerConnection.ts            # Serialization + framing over transport
    StorageManager.ts            # Persist/restore via storage plugin
    GossipRouter.ts              # Gossip actions → network sends
    GarbageCollector.ts          # LRU eviction

  util/                        # Pure utilities (no scaffold dependencies)
    Hash.ts
    BaseContext.ts
    secp.ts
    Monitor.ts
    MaybePromise.ts
    MessageSplitter.ts
    ... (all existing util files)

  contracts/                   # Built-in contract implementations
    AccountContract.ts
    DataContract.ts
    ... (existing contracts)

  demo/                        # Self-contained demo (already works)
    DemoNode.ts
    Transport.ts
    ...

  types.ts                     # Shared types (Verifier, Output, etc.)

plugins/                       # Platform-specific implementations
  browser/
    WebrtcPlugin.ts
    LocalStoragePlugin.ts
    OpfsStoragePlugin.ts
    BrowserDefaults.ts           # browserPlugins() helper
  deno/
    DenoKvStoragePlugin.ts
    WebsocketServerPlugin.ts
  WebsocketClientPlugin.ts      # Works in both browser and Deno
  ConsoleLoggingPlugin.ts
  testing/
    MockNetworkPlugin.ts
    MockTimePlugin.ts
    SeededEntropyPlugin.ts
    NullStoragePlugin.ts

legacy2/                       # Old services (reference, gradually delete)
  FactService.ts
  BlockService.ts
  ... (everything from src/ that isn't in the new structure)

legacy/                        # Original legacy (already exists)
  ...

tests/
  core/
    BlockCreationModule.test.ts
    ConflictModule.test.ts
    ConsensusModule.test.ts
    GossipModule.test.ts
    SamplingModule.test.ts
    TrustModule.test.ts
    Integration.test.ts
  node/
    ReactiveLayer.test.ts
    FetchManager.test.ts
    strategies/
      AggregationStrategy.test.ts
      ...
  contracts/
    ...
  demo/
    ...
```

## 8. Implementation Order

### Phase 1: Minimal end-to-end (P0)

**Goal:** `scaffold.fetch()` and `scaffold.put()` work locally (single node, no networking, no autonomous behaviors). This validates the public API design.

1. Create `src/Scaffold.ts` (new) — facade delegating to managers
2. Create `src/node/NodeContext.ts` — holds ProtocolContext + plugin references
3. Create `src/node/PutManager.ts` — creates blocks from PutRequest
4. Create `src/node/FetchManager.ts` — manages subscriptions, handles incentive blocks
5. Create `src/node/ReactiveLayer.ts` — skeleton: runs strategies after blockReceived
6. Create `src/node/strategies/FetchNotifyStrategy.ts` — notifies fetches on changes
7. Write tests: put a block, fetch it, see callback fire

### Phase 2: Contract execution (P1)

**Goal:** Fetch triggers generation and returns computed results.

1. Create `src/node/ContractExecutor.ts` — wraps JS contract functions
2. Create `src/node/strategies/GenerationStrategy.ts` — react to incentive blocks
3. Test: register contract, fetch verifier, see contract execute and result returned

### Phase 3: Multi-node networking (P1)

**Goal:** Two nodes can exchange blocks.

1. Create `src/node/PeerConnection.ts` — serialize/deserialize blocks over transport
2. Create `src/node/NetworkManager.ts` — plugin lifecycle, bootstrap
3. Create `src/node/GossipRouter.ts` — translate push actions to network sends
4. Adapt `MockNetworkPlugin` for new interfaces
5. Test: two nodes, put on one, fetch on the other

### Phase 4: Reactive aggregation (P1)

**Goal:** Canonical leaves are automatically aggregated.

1. Create `src/node/strategies/AggregationStrategy.ts`
2. Remove `attemptAggregation` from Coordinator (it's now a strategy)
3. Test: multiple leaves share anchor → aggregation block created automatically

### Phase 5: Sampling and verification (P1)

**Goal:** Canonical blocks are sampled and verified.

1. Create `src/node/strategies/SamplingStrategy.ts`
2. Test: canonical block → sampling picks it → contract re-executed → weight updated

### Phase 6: Storage persistence (P1)

**Goal:** Blocks survive restarts.

1. Create `src/node/StorageManager.ts`
2. Test: put blocks, close, reopen, blocks still there

### Phase 7: Dispute and collateral (P2)

**Goal:** Invalid blocks are challenged.

1. Create `src/node/strategies/DisputeStrategy.ts`
2. Test: invalid block → verification fails → dispute block created

### Phase 8: Production networking (P2)

**Goal:** Real WebSocket and WebRTC connections.

1. Adapt `WebsocketClientPlugin` and `WebsocketServerPlugin`
2. Adapt `WebrtcPlugin` (needs new signaling path)
3. Integration tests with real transports

### Phase 9: WASM execution (P2)

**Goal:** Contracts can be WASM modules.

1. Extract worker system as `WasmPlugin`
2. Implement `ContractFn` wrapper for WASM execution
3. Test: WASM contract execution + verification

## 9. Reactivity: Detailed Example

To make the reactive model concrete, here's the full flow for a fetch request:

```
User calls: scaffold.fetch(V, { onResult })

  1. FetchManager records subscription for V
  2. FetchManager creates incentive block:
     put({ data: encode(V), contract: INCENTIVE_HASH, weight: incentive })
  3. This calls coordinator.blockReceived(incentiveBlock)
  4. Reactive layer evaluates strategies:
     - GenerationStrategy sees incentive for V
     - If we have contract for V.contract:
       - Execute contract → get result
       - put({ data: result, satisfies: V })
       - This calls coordinator.blockReceived(responseBlock)
       - Reactive layer evaluates again:
         - FetchNotifyStrategy sees response for V
         - Calls onResult(result)
         - AggregationStrategy checks for aggregation opportunities
  5. Meanwhile, gossip pushes incentive block to peers
  6. Peers see incentive → their GenerationStrategy fires → they publish responses
  7. We receive peer responses via network → coordinator.blockReceived
  8. Reactive layer fires → FetchNotifyStrategy updates with stronger result
  9. If canonicality changes (reorg), FetchNotifyStrategy calls onResult(null)
     then onResult(newResult) if a different result becomes canonical
```

No polling. No intervals. Every state change propagates through the coordinator and reactive layer synchronously. Network I/O is the only async boundary.

## 10. Open Questions

1. **Signal exchange for WebRTC.** Currently, WebRTC signaling goes through FactService. In the new system, we need a way to exchange SDP/ICE candidates between peers. Options: (a) use blocks as a signaling channel (blocks containing connection signals), (b) side-channel through bootstrap server, (c) signaling-specific plugin method.

2. **Block header schema unification.** The Block interface has fields from different modules (consensus weight, gossip size, trust collateralTarget). Should we formalize this as a proper schema, or keep it as a TypeScript interface?

3. **Request routing.** When a fetch is published as an incentive block, how do peers discover it? Currently through gossip. Is the gossip module's utility scoring sufficient to prioritize incentive blocks, or do we need explicit request routing?

4. **Computation DAG.** When a contract calls `ctx.request(otherVerifier)`, how does this interact with the reactive layer? Is it a synchronous lookup of cached results, or does it trigger a nested fetch? The former is simpler but may miss results; the latter is more correct but complex.

5. **Genesis agreement.** How do nodes on the same network agree on genesis? Currently it's compiled in. Should it be part of the config? Part of the network identifier?
