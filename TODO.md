# TODO

Queued protocol work, roughly in priority order. Each item follows the 4-step development sequence in AGENTS.md: document → skeleton → test → implement.

## Chess Demo Follow-ups

The chess demo in `src/demo/chess/` exercises many protocol primitives (GAME_STATE UTXO threading, getOutput injection, signature-gated generation, terminal payouts via throughput) but defers several things:

### Application-driven put() racing with reactive strategies
The 2-node multi-move game test is flaky when DraftStrategy and PiggybackStrategy run. Even with `enablePiggyback: false` and `enableGeneration: (h) => h !== GAME_STATE_CONTRACT`, some code path still creates competing draft blocks that claim the prev GAME_STATE UTXO on one node while the legitimate move block claims it on the other. Two-node create+join and single-move propagation are stable (`tests/ChessGame.test.ts`); 4+ moves in sequence is not. The underlying issue is that Scaffold's reactive strategies assume they are the authoritative producer of response blocks for any registered contract, but `ChessGame` drives construction directly via `scaffold.put()`. We need either (a) a first-class "I'm driving this contract myself" API that tells all reactive strategies to keep hands off a given verifier, or (b) the draft/piggyback paths should yield when a local put() has already claimed the same UTXO within the current coordinator cycle.

### Validity dispute resolution
`CollateralContract`'s `'validity'` ChallengeTarget type exists but has no resolution path — only `hash_preimage` disputes are implemented. The chess demo would benefit from end-to-end "cheater publishes invalid move → their FOR collateral is slashed." Need at minimum a degenerate "anyone can re-run the contract and claim the FOR" mode; full bisection protocol is future work.

### `UtxoIndex.findByContract`
Enumerating unspent UTXOs by contract hash alone (across all verifier params) is not directly supported. `ChessGame.listActiveGames` currently scans `store.values()` and cross-checks `UtxoIndex.getByVerifier`. For a lobby view that shows every open chess game this is O(blocks) per call. Adding a secondary index `contract → Set<paramsKey>` would make it O(known games).

### Block timestamp validation
The chess contract relies on `block.timestamp` for clock arithmetic, but the protocol doesn't validate timestamps anywhere. A malicious publisher could backdate their block to avoid a clock-timeout. The contract enforces monotonicity (`now > prev.lastMoveAt`) but no upper bound. Need a gossip-layer sanity bound (`block.timestamp <= local_now + 10s`) and/or a contract-visible `getReceivedAt()` so contracts can compare self-published timestamps against the peer's observation.

### Collateral posting for chess moves
The chess demo publishes move blocks without FOR collateral, so verification-layer rejection prevents bad blocks from becoming canonical but there's no economic penalty for attempting fraud. Layering `CollateralStrategy` (tracked separately above) on top of `ChessGame` would complete the incentive story.

### `scaffold.put` should handle agg-marker-aware claim indices
`ChessGame.publishClaimBlock` has to prepend `makeAggregationOutput()` to its own spec.outputs so that claim indices aren't shifted by Scaffold's implicit agg-marker append. This is demo-layer glue that every application will re-invent. Either `scaffold.put` should shift external claim indices when it appends a marker, or the `PutRequest` API should grow a `consume: Hash[] | ResolvedClaim[]` field that resolves to indices AFTER marker placement.

### ChessGame generation via `registerOutputHandler`
The current ChessGame wrapper bypasses the generation path entirely — moves are constructed directly via `scaffold.put()`. The `getOutput` + `OutputHandlerRegistry` path (newly landed) should eventually drive move construction: black's `fetch({contract: GAME_STATE, params: nextTurn})` publishes an incentive; white's registered output handler resolves when the user picks a move; `GenerationService` runs the contract to build the response block. This would exercise the host handler chain end-to-end and is the "proper" demo of the whole generation mechanism. Blocked on the racing issue above.

## Core Protocol

### Fold `SamplingModule.selfVerified` into BlockVerificationModule
Phase 1 of the verification-state unification left `SamplingModule` tracking its own per-block `selfVerified: boolean` inside `BlockSampleState`. `BlockVerificationModule` is now the authoritative source of "did the contract accept" via `getStatus()`. Sampling's weight-factor computation should read from there instead of its own shadow flag. Non-blocking; both are always updated together via `Coordinator.attemptVerification`. See `src/core/SamplingModule.ts:32-37`.

### Collateral Posting Strategy
The TrustModule tracks collateral and the DisputeStrategy emits `dispute` actions for invalid blocks, but there is no strategy for **posting** collateral. Need a `CollateralStrategy` that:
- Posts FOR collateral on blocks we generated (publisher obligation for hard contracts)
- Posts FOR collateral on blocks we verified as valid (earn resolution reward)
- Posts AGAINST collateral when verification fails (trigger dispute)
- Manages collateral lifecycle: redemption after aggregation, reclaim when non-canonical
- **Auto-stake on locally-verified piggybacks.** [PiggybackStrategy](src/node/strategies/PiggybackStrategy.ts) builds + verifies + broadcasts a piggyback but does not currently post FOR collateral on it. Without a stake the piggyback loses on weight to any responder that did stake; wire piggyback's verify-pass step into the same node policy that decides "would we stake on anything we verified?".

The reactive action types (`createBlock` with collateral outputs) exist, but the decision logic for when and how much to stake is unimplemented. The [CollateralContract](src/contracts/CollateralContract.ts) handles resolution; this is about the posting side.

### Pre-publish Piggyback (incentive cancellation)
[PiggybackStrategy](src/node/strategies/PiggybackStrategy.ts) only piggybacks against already-published incentives. The [piggyback design](docs/design/piggyback.md) sketches a "pre-publish" path: when a trusted satisfying block appears before our own incentive has been broadcast, build a local-only piggyback and cancel the enqueued incentive instead of paying. Requires PutManager-side introspection of queued-but-unpublished incentive blocks (not exposed today). Defer until there's user demand or the `publish: false` fetch path needs it.

### Phase 4b: `publish: false` fetch + local-only piggyback
[FetchManager](src/node/FetchManager.ts) currently throws `NotImplementedError` for `publish: false`. Wiring this up requires the pre-publish piggyback mechanism above: build an incentive block locally, skip broadcast, and let the piggyback strategy construct local-only copies from trusted network sources. Design covered in [docs/design/fetch.md](docs/design/fetch.md) and [docs/design/piggyback.md](docs/design/piggyback.md).

### Trust-gate integration for fetch callbacks
The [fetch design](docs/design/fetch.md) specifies that `FetchManager` should gate response surfacing on [TrustGate](src/node/TrustGate.ts) — only fire callbacks for blocks that have been locally verified or collateral-backed. [FetchManager.ts](src/node/FetchManager.ts) currently surfaces on canonical resolution alone (trust-gate wiring is in place for `verify: true` but disabled for streaming callbacks). The blocker is that [`collectExtendedOutputs` in Block.ts](src/core/Block.ts:215) does not walk aggregate subtree outputs — it only returns `[own outputs, surviving anchor outputs]`, omitting per-aggregate slots described in [output-claims.md](docs/protocol/output-claims.md). Response contracts that claim through an aggregate chain (common for any generator-produced block with non-trivial anchor/aggregate structure) fail verification with `no more inputs available` because the extended-vector index doesn't resolve to the expected output. Fix: extend `collectExtendedOutputs` to include aggregate outputs in the documented order, then re-enable the trust gate in `FetchManager._reevaluate`.

### WASM Contract Runtime
`ContractHost` currently uses a TypeScript mock contract registry. Replace with real `WebAssembly.instantiate` loading, host function bindings (imports), and memory management. The `runVerifying` / `runGenerating` surface stays the same -- only the contract dispatch changes. The [WasmStore](src/core/WasmStore.ts) exists as an in-memory binary store but is not yet consumed for actual WASM execution.

### Generator Implementation
[Generator.ts](src/core/Generator.ts) is a `StubGenerator` that records generate/cancel signals without performing real computation. The new [GenerationModule](src/node/GenerationModule.ts) / [GenerationService](src/node/GenerationService.ts) replace the old `ContractGenerator`, but still depend on a real contract host.  Need to:
- Run contracts in generation mode via [GeneratingEnv](src/core/GeneratingEnv.ts) through `ContractHost.runGenerating`
- Handle async WASM execution
- Integrate with execution-queue priority (canonicality-driven deprioritization, restart-on-uncanonical)

The [GenerationStrategy](src/node/strategies/GenerationStrategy.ts) already detects incentive blocks and emits `createBlock` actions, but the actual contract execution is stubbed.

### Execution Queue Preemption
Today the queue only terminates tasks via wall-clock timeout. Need cooperative cancellation + pressure-driven eviction so the queue can:
- Abort a running task before its budget expires (requires `Executable.abort?: AbortSignal` or equivalent).
- Evict the lowest-priority running task when a higher-priority task arrives and the pool is full.
- Track a pressure signal: running workers today; live WASM instance count once WASM lands.
- Propagate eviction back to callers via `onComplete` with `{ outcome: 'terminated' }` -- verification/generation modules then decide whether to re-enqueue.

Blocks: making `GenerationModule`'s canonicality-driven deprioritization actually reclaim resources for stale drafts. See [execution-queue.md](docs/protocol/execution-queue.md#deferred-preemption-and-cooperative-cancellation).

### Block-Level Verification Budget Cap
`ContractVerificationModule` currently gives each `{block, verifier}` its own full budget. A block with many verifiers can consume N × budget wall-clock time. Need a per-block cumulative cap that terminates all in-flight verifiers for a block once the block's cumulative wall-clock exceeds the cap. Gated on execution-queue preemption (needs the abort surface to cancel running verifiers).

### GenerationModule Priority Calibration
`GenerationModule.priority()` multiplies `declaredWeight` by a canonicality factor when the draft is non-canonical. Current factor is a placeholder. Needs calibration once we observe real generation cadence:
- How aggressive should the demotion be? (Low enough that canonical work always wins; high enough that a transient flip doesn't permanently bury a draft.)
- Should the factor decay over time, or only respond to canonicality flips?
- Should it distinguish "anchor-chain uncanonical" (recoverable) from "lost a direct conflict" (structural)?

### Weight-Ramp Cadence
`GenerationModule` updates a draft's verified weight toward `declaredWeight` during generation. Cadence choices: on-timer, on-env-step, on-contract-host-tick. Pick once WASM-based contracts land and we see typical instruction counts between yield points.

### Deception Module
Formalize the strategic deception equilibrium from [deception.md](docs/protocol/deception.md): insurance commitments on FOR collateral, self-catch mechanism for trap blocks, and calibrated fraud rates. Requires the dispute module (done) and economic equilibrium analysis. No core module exists yet.

### Aggregation marker migration to null-data
With `Output.data: Uint8Array | null` landed, the aggregation marker -- currently `new Uint8Array(0)` as an overloaded sentinel in [AggregationContract.ts:73](src/contracts/AggregationContract.ts) and checked via `length === 0` in three sites (AggregationContract.ts:58, 111; [NodeContext.ts:634](src/node/NodeContext.ts); [Scaffold.ts:146](src/Scaffold.ts)) -- is semantically a null-data output. Direct migration is **blocked**: the aggregation contract declares `AGGREGATION_CONTRACT` as an `outputNamespace`, so null in that namespace would violate the partition rule (null must be unowned). Migration requires either (a) moving markers to a distinct unowned namespace (e.g., `AGGREGATION_MARKER_CONTRACT`) before flipping to null, or (b) deciding to leave empty-bytes as the marker convention and documenting it. Low priority; the current empty-bytes sentinel works. The Phase 1 null-data commit keeps both checks for compatibility.

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

## Harness (v2)

The v1 harness (`harness/`) targets 100 processes with simulated latency and
anonymous/authenticated Unix sockets. Known gaps to address before scaling:

- **Peer-aware latency for accepted connections.** `LatencyTransport` wraps
  outbound sends; for inbound accepted connections it has no peer identity
  and falls back to `fleet_fallback_ms`. Needs a mechanism to learn the peer
  pubkey after Scaffold signaling completes and update the per-connection
  delay.
- **Concurrent dial coord queue.** The FIFO queue in `LatencyTransport`
  assumes dial completion order matches dial order; concurrent dials can
  swap coords. Switch to a map keyed by the dial promise.
- **Real scaffold traffic in behaviors.** `social_media`, `money_send`, and
  the others emit intent events but do not call `scaffold.put()` /
  `scaffold.fetch()` against real contracts. Wire them up once the
  harness is proven.
- **Persistent per-user state (StorageProvider).** Each session currently
  cold-starts. A mock StorageProvider that restores prior BlockStore state
  by user pubkey would let us test realistic re-join flows.
- **Packet loss, partitions, byzantine behaviors.** V1 deferred these; add
  as optional features on top of LatencyTransport and `peerManifest`.
- **Bandwidth / compute caps.** Trusted Scaffold to self-limit for v1. If
  host OOMs or hangs under stress, add explicit limits here.
- **coordinator ↔ observer backpressure.** Coordinator should pause spawns
  when `runs/<id>/events/` size exceeds `lag_threshold_bytes`; currently
  just configured, not enforced.

## Application Layer

These sit on top of the core protocol and can be specified later.

### Game State Contracts
Deterministic WASM execution for serverless game-state consensus. Dispute/penalty mechanics for incorrect state transitions. The ContractEnv interface (VerifyingEnv/GeneratingEnv) supports the full host function interface needed (requireResult, requireOutput, fetch, collectInputs).

### Content Distribution
Social content from peers with signatures and globally consistent latest-state resolution.

### Marketplace / Escrow
Decentralized marketplaces with escrow and protocol-level resolution/voting.
