# TODO

Queued protocol work, roughly in priority order. Each item follows the 4-step development sequence in AGENTS.md: document → skeleton → test → implement.

## Cohesion / Refactor (do these first)

These are the items that cause the most hidden bugs today. Most of the bugs we hit during the chess demo bringup were the same shape: state that should have transitioned didn't, because no single component owned the transition. Doing these in priority order pays down the structural debt that future features will otherwise step on.

### 1. Generation lifecycle as a state machine
**Partially landed** in the Node refactor. Steps 6-9 collapsed several of the originally separate stores into Draft's own status union (now `populating | ready | solidifying | solidified | cancelled` after the 2026-05 producer-agnostic refactor); `BlockBuilderModule` owns the lowering pipeline; `DraftManager.detachDraft` cleanly separates "remove from consensus" from "mark draft terminal." Drafts persist as terminal nodes for debug history.

What's still split across multiple stores: `DraftStrategy.inFlight` + `.resumed`, `GenerationService._blocked` + `._parkedGetOutput` + `._preQueue`, the `setOutputReleasedHook` / `setCancelHook` callback web. These should be derived from `Draft.status` (extended with `awaitingInput` / `parkedOnGetOutput` phases) rather than maintained as parallel state. After that, the leaked `OutputHandler` Promises and the `GenerationService._onRestart` no-op fall out as data-flow consequences rather than independent bugs.

### 1a. Producer-flip migration (chunks 6-8 of the don't-worry-about-gc plan)
The 2026-05 refactor landed the producer-agnostic DraftManager API (`create`, `updateDraft`, `markReady`, `markSolidifying`, `cancel`) and the `solidifiedBlocks` tracking + re-solidify-with-conflict-ancestors pipeline. The legacy `createDraft`/`addReady`/`cancelDraft` methods remain alongside the new API; consumers haven't been migrated yet.

Pending migrations:
- `GenerationService` should stop implementing `GeneratorProvider` and become a producer driven by a new `enqueueGeneration(trigger)` entry point. Includes a whitelist (SIGNATURE_CONTRACT etc.) selecting `markReady` for piggyback merge vs `markSolidifying` for immediate publish.
- `PutManager.put` should use `create → updateDraft → markSolidifying/markReady` instead of `addReady + solidify`.
- `FetchManager._publishIncentive` should create a draft via the API (`create({outputs: [incentive, agg-marker]}) → markSolidifying`) instead of dispatching a `createBlock` action.
- A pump for `ready` drafts: either PiggybackStrategy aggregates them, or a new strategy. Today the NodeContext auto-solidify listener fires on transitions to `solidifying` (re-entrancy-guarded by `DraftManager.isSolidifyActive()`); once the pump lands, the listener can go away.
- Once all consumers have migrated, delete `createDraft`, `addReady`, `cancelDraft`, and rename `updateDraft` → `update`.

See `~/.claude/plans/don-t-worry-about-gc-iterative-metcalfe.md` for the full chunk list and test matrix.

### 1b. Draft GC
Solidified drafts live forever today (`solidifiedBlocks` retained indefinitely for re-solidify on canonicality flip). At finalization depth the risk of a canonical block flipping uncanonical drops to ~0, so the draft can be safely GC'd. Out of scope for the current pass; track here.

### 2. Output_space / extended_vector terminology audit
Cheapest item in this section, biggest cost-saving for future-you. The codebase has at least three different things called "extended" and they do not all mean the same thing. AGENTS.md says `extended_vector(X) = X.outputs ++ aggregate.new ++ output_space(anchor)`. Some now-deleted code meant `own ++ surviving-anchor-after-this-block's-claims-into-anchor`. `UtxoEntry.extendedIndex` is yet another thing. Some method names use "claim" / "extended" / "output space" interchangeably.

Write the canonical definition once in [`docs/protocol/output-space.md`](docs/protocol/output-space.md), then audit every comment and identifier that uses "extended" and either align it or rename to "output space" / "post-subtree" / "post-claim survivors" as appropriate. ~30 minutes; saves hours later.

### 3. `OutputClaimModule.tryMigrate` should call `OutputSpaceModule.resolveClaimIndex`
After today's fixes, `tryMigrate` walks the hierarchy by hand — own → aggregate → anchor with two `mapSurvivingToOriginal` calls inline. The walk is exactly `OutputSpaceModule.resolveClaimIndex` but iterative rather than recursive. Replace with: `target = outputSpace.resolveClaimIndex(claimant, claimIdx); placeEntry(target.block, target.outputIndex, entry)`. Drops `getSubtreeClaimMask` / `getOwnClaimMask` from the provider interface and the rebase logic in OutputSpace.

### 4. ~~Split draft reservations from real-block spends in `UtxoIndex`~~
**Landed** in step 7 (`1accccd`). Atomic-claim invariant: an output is unspent iff no canonical Node has a claim pointing here. Drafts and blocks unified under `UtxoIndex.isUnspent`; `isUnspentByCanonicalBlock` deleted. Chess UI / BalanceIndex now query the standard `UtxoIndex.isUnspent`.

### 5. `OutputSpaceProvider` factory for not-yet-hashed specs
`NodeContext._solidifyDraft` and `BlockCreationService.solidify` both hand-roll a `virtualProvider` to compute claim indices for an unfinalized block. Pull into a single `makeSpecOutputSpace(spec, store)` factory, mirroring `makeBlockStoreOutputSpace`. Pair with deleting `getBlockClaimMask` from `Block.ts` — used in one place now, leaks the same "extended vs output_space" confusion.

### 6. ~~Drop the microtask defer in `_solidifyDraft`~~
**Landed** in step 10. Once `BlockBuilderModule` separated lowering from re-entrant draft state mutation (and `detachDraft` cleanly separates consensus removal from terminal-status transition), the synchronous `processBlock` no longer triggers the chess turn-1-style cascades the defer was guarding against. Removed; cycle-protection in `ReactiveLayer.processBlockInner` carries the load.

### 7. Smaller items
- **`useFloodGossip` and `enablePiggyback` are coupled flags** with a runtime check that fails silently if you set one without the other. Bake into the type.
- **Expose `DraftStrategy` config (`minValue`, `maxConcurrent`, `enableGeneration`) through `ScaffoldConfig`.** The chess demo had to pass `enableGeneration` directly during bringup. Once #1 lands, `maxConcurrent` may stop mattering; until then, expose it.
- **TransportManager fires two `peerConnected` events** for the same logical pubkey (one anonymous, one authenticated). Filter dupes inside the manager rather than asking every consumer to dedup.
- **`BalanceIndex` walks `store.values()` on every read.** Make it incremental like `UtxoIndex`.
- **`BlockReceivedResult.canonicalityChanges` mixes real block hashes and phantom draft hashes.** Consumers like `DraftStrategy.evaluate` keep tripping on "is this hash a block or a draft?" Tag entries with a discriminant.

### 8. Node refactor follow-ups
- **Wall-clock `effectiveWeight` ticker.** Step 8 introduced `effectiveWeight` on `Draft` and wired `ConsensusService.getWeightVector(draft) = max(declaredWeight, effectiveWeight)`. The 1Hz timer that bumps `draft.effectiveWeight` for non-terminal drafts (and pokes consensus to re-evaluate) is not yet implemented -- today `effectiveWeight` stays at 0 and `declaredWeight` is the static contribution. Lives naturally in `NodeContext` alongside the canonicality wiring; bump should call `consensus.setVerifiedWeight(draft.draftId, [...])` to propagate.
- **Audit draft canonicality competition / generator pause-resume.** Drafts already participate in `ConsensusModule` via `setVerifiedWeight(draftId, ...)` and `OutputClaimService` already detects two drafts claiming the same output as a conflict. The "pause losing draft's generator on canonicality flip" wiring partially exists in `GenerationModule.onCanonicalityChange` but hasn't been re-verified end-to-end since the `pickAnchor` refactor. Worth a focused integration test: two drafts on the same seed, confirm only the heavier one's generator pumps, the loser's generator is suspended, and roles flip when weights cross.
- **Drop `Draft.draftId`** (and use object equality for consensus identity). Currently `draftId: Hash` is the consensus-side key (`ConsensusModule.addBlock(draft.draftId)`). Dropping requires teaching `ConsensusModule` to operate on Node references rather than `Hash`. Touches ~130 sites; the scope is the `ConsensusModule` rewrite plus call-site migration. Defer until ConsensusModule is generalised.
- **`BlockBuilderService` (parked-draft retry loop).** `BlockBuilderModule.build` returns `{ awaitingAnchor: true }` when no producer's anchor chain bridges all claims, but today `_solidifyDraft` treats that as a hard failure (the draft transitions to `failed` with reason "awaiting anchor"). The intended behaviour: park the draft, replay all parked drafts when a new aggregation block becomes canonical, retry until either it succeeds or it's still unbridged. Lives naturally in a `BlockBuilderService` subscribing to `consensus.onCanonicalityChange` for new aggregator-shaped blocks. Pairs naturally with the lifecycle state machine in #1 (a new `awaitingAnchor` phase) so deferring until #1 lands.
- **Generation pipeline simplification.** Step 8 (`0c7c159`) migrated `GeneratingRunResult` and `GeneratingEnv` to `ClaimRef[]` (no value). Step 10 (`1d249f9` follow-on) deletes the unused `Block.resolvedClaims` field, the `ClaimIntent` type, and the stale comments referencing `resolvedClaims` throughout `UtxoIndex` / `GenerationService` / `GossipModule`. The `_resolvedClaims` private name in GeneratingEnv was renamed to `_claims`. Done.
- **Anchor-aware `pickAnchor` for B+C-anchored-to-A case.** The current `AnchorSelection.pickAnchor` returns `{ anchor: A, aggregates: [B, C] }` for that exact case (works as-is). What it doesn't yet do is **pick the right aggregator block when one exists**: if a real aggregator over [B, C] anchored to A is already in the store, picking it as the anchor (instead of A + virtual aggregation of B and C) gives a cleaner solidification. Worth a follow-up after `BlockBuilderService` lands.

## Dev-demo dev-tab broken on current plugin

`demo/src/dev-demo/compilerHashes.ts:publishEchoContract` still publishes a contract block with the legacy `wasm` + `wasm_layers` records. The current `WasmContractPlugin` requires a `modules` record (added during A4 stacking) and only fetches blobs by hash via `HASH_CONTRACT` + RECORD_CONTRACT/'default'. To make the dev-tab work again, `publishEchoContract` needs to:
1. Publish a HASH_CONTRACT block carrying the echo WASM bytes as a RECORD_CONTRACT/'default' output (the discovery beacon).
2. Publish a separate contract block whose `modules` record is `{ base: {version, imports: {run: "main:run"}, memories: {heap: {...}}}, layers: {main: {wasmHash: <hash>, imports: {"scaffold_env.*": "base:*", "env.memory": "base:heap"}}} }`.
3. Return the contract block's hash (callers use that as `compilerHash`).

The C0 echo fixture in `demo/src/dev-demo/fixtures/echo.wasm` is still valid -- only the publishing dance needs updating.

## JS compiler: out of bundle, wire the real demo path + the as-a-block end-state

The JS compiler was removed from the npm bundle (2026-06-16). `src/contracts/JsCompilerContract.ts` and `src/wellKnown.ts` now live in `src/` but are excluded from `scripts/build_npm.ts`; `Scaffold` no longer auto-registers the compiler or auto-seeds well-known blocks. Hosts register the compiler explicitly with injected blob hashes (tests via `tests/helpers/jsCompiler.ts`, the demo via `compilerHashes.ts:registerJsCompiler`). Follow-ups:

- **Demo: run the real JS compiler on the js/ts tabs (Workstream C).** `registerJsCompiler` registers the compiler and `compilerHashes.ts` holds the blob-hash constants, but the language tabs still invoke the echo placeholder. To switch js/ts to the real compiler the demo must (a) seed the well-known blob blocks (wasi-shim, QuickJS, json-wb) into the Scaffold so the compiled contract's blobs resolve -- load `well-known-blocks/<name>/dist/block.bin` via Vite `?url` and pass them as `wellKnownBlocks`, mirroring `loadEchoBytes`; and (b) invoke via the compiler's `put({ contract, params: { files } })` shape (LanguagePanel currently `fetch`es with raw source bytes, which only fits echo).
- **Blob-hash constants drift.** `compilerHashes.ts` hardcodes the three `blobHash` values from `well-known-blocks/<name>/dist/hash.json`. There is no automated check that they match after `deno task build:well-known`. Either codegen the constants from `hash.json` or add a build-time assertion.
- **Compiler as a genuinely published block (the real end-state).** Today the compiler is a native TS contract registered under the synthetic hash `Hash.digest('js-compiler-contract')`, not a content-addressed block fetched from peers. Making it a real block is blocked: the JS runtime `scaffold` global (`src/contracts/js-runtime/prelude.ts`) exposes only `params()`/`result()`, not `put`, so a JS-runtime contract cannot assemble the CONTRACT_CONTRACT block the compiler produces. Resolving this needs either exposing `env.put` to JS-runtime contracts (with the attendant incentive/security design) or authoring the compiler as a WASM contract.

## Chess Demo Follow-ups

The chess demo in `src/demo/chess/` exercises many protocol primitives (GAME_STATE UTXO threading, getOutput injection, signature-gated generation, terminal payouts via throughput) but defers several things:

### Generator lifecycle bugs surfaced during chess bringup
[`docs/design/chess-turn-one-bug.md`](docs/design/chess-turn-one-bug.md) documents the original turn-1 bug plus three related issues: stale `DraftStrategy.inFlight` entries, leaked `OutputHandler` Promises on draft cancel, and `GenerationService._onRestart` being a no-op. Two were patched during the demo bringup — a sweep in `DraftStrategy.evaluate` clears `inFlight` entries whose seed has been spent, and a microtask defer in `_solidifyDraft` breaks the synchronous re-entrant cascade. Move-side `requireSignature(mover)` was also moved to before `getOutput` so non-mover generators die before parking. The leaked Promises and `_onRestart` remain. The right fix for all of them is the lifecycle state machine in **Cohesion / Refactor #1** above; until that lands, the bandaids hold.

### Restore chess timeout-claim flow
`GameStateContract` now calls `requireSignature(mover)` before reading the move, which is what kills non-mover generators early (so phantom claims don't reserve the seed UTXO). The previous opponent-signed timeout branch (`isTimeoutMove(move)` after reading the move) is incompatible with that ordering and is currently disabled — the timeout test in `tests/GameStateContract.test.ts` is `ignore: true`. Re-add via a separate verifier-params slot (`RECORD/"timeout"`) or a generator-side signer dispatch (`env.getSigner()` followed by branching). Keep the early-exit property so opponent generators on the normal-move path still die promptly.

### Validity dispute resolution
`CollateralContract`'s `'validity'` ChallengeTarget type exists but has no resolution path — only `hash_preimage` disputes are implemented. The chess demo would benefit from end-to-end "cheater publishes invalid move → their FOR collateral is slashed." Need at minimum a degenerate "anyone can re-run the contract and claim the FOR" mode; full bisection protocol is future work.

### `UtxoIndex.findByContract`
Enumerating unspent UTXOs by contract hash alone (across all verifier params) is not directly supported. `ChessGame.listActiveGames` currently scans `store.values()` and cross-checks `UtxoIndex.getByVerifier`. For a lobby view that shows every open chess game this is O(blocks) per call. Adding a secondary index `contract → Set<paramsKey>` would make it O(known games).

### Block timestamp validation
The chess contract relies on `block.timestamp` for clock arithmetic, but the protocol doesn't validate timestamps anywhere. A malicious publisher could backdate their block to avoid a clock-timeout. The contract enforces monotonicity (`now > prev.lastMoveAt`) but no upper bound. Need a gossip-layer sanity bound (`block.timestamp <= local_now + 10s`) and/or a contract-visible `getReceivedAt()` so contracts can compare self-published timestamps against the peer's observation.

### Collateral posting for chess moves
The chess demo publishes move blocks without FOR collateral, so verification-layer rejection prevents bad blocks from becoming canonical but there's no economic penalty for attempting fraud. Layering `CollateralStrategy` (tracked separately above) on top of `ChessGame` would complete the incentive story.

### `scaffold.put` should handle agg-marker-aware claim indices (create block only)
**Obsoleted by the put/send/fetch unification (2026-05-22).** `Scaffold.put` is now narrowed to `{contract, params, records}` and no longer accepts caller-supplied claims. Code that needs to pair outputs with input claims drives `DraftManager` directly. ChessGame.createGame and the dev-demo scripts switched to that path.

### Replace `useFloodGossip` demo escape hatch with real baseline routing
`demo/src/chess/ChessApp.tsx` runs with `useFloodGossip: true` (and `enablePiggyback: false` because flood mode bypasses piggyback's `submitBlock` delayed-broadcast path). Flood mode bounds propagation via per-atom seen-sets in `ReactiveLayer` (blocks) and `NetworkBridge` (signals, requests). It exists because of the missing baseline-propagation step (see "Baseline propagation for cold-start" below). Once routing has a real cold-start mechanism, the chess demo can drop both flags and fall back to claim-history routing. Flood mode itself can stay as a deliberate testnet/demo option.

### Bound flood-mode seen-sets before mainnet
`NetworkBridge.seenSignals` / `seenRequests` and the implicit `BlockStore.has`-based block dedup all grow without bound under `useFloodGossip: true`. For demo and short-lived testnet sessions this is fine, but a long-running node would leak. Before mainnet, replace the `Set<string>` instances with an LRU or time-windowed structure (e.g. ring buffer of recent atom hashes), and let `BlockStore` evict cold history once weight is settled.

## Core Protocol

### Baseline propagation for cold-start
`docs/protocol/gossip.md:250-258` and `routing.md:266` reference "baseline propagation" but `RoutingModule.handleSendAction` (src/node/RoutingModule.ts:237-279) only emits `PushAction`s when a peer's `receivedFirst` matches the trigger verifier — there's no fallback when both `claimHistory[V]` and `contractFallback[contract(V)]` are empty. Result: brand-new contracts (e.g. the chess demo's `GAME_STATE_CONTRACT`) have no propagation path on a fresh network. Two options documented in the spec: (a) push-to-all when local node is the origin and no claim-history match exists, with rate-limiting and abuse considerations; (b) peerInfo contract-interest advertisement (already tracked as the long-term "Request Routing" item). Until either lands, `Scaffold.sendBlockToPeer` is the only escape hatch and demos hand-roll fanout.

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
The [fetch design](docs/design/fetch.md) specifies that `FetchManager` should gate response surfacing on [TrustGate](src/node/TrustGate.ts) — only fire callbacks for blocks that have been locally verified or collateral-backed. [FetchManager.ts](src/node/FetchManager.ts) currently surfaces on canonical resolution alone (trust-gate wiring is in place for `verify: true` but disabled for streaming callbacks). The previous blocker — `collectExtendedOutputs` not walking aggregate subtrees — is resolved (claim resolution now goes through `OutputSpaceModule` everywhere). Re-enabling the trust gate for streaming callbacks is now a follow-up rather than a deep blocker.

### Generic JSON codec: host fast-path vs. contract-declared codec
**Landed:** the generic JSON walker/builder WASM module (`src/contracts/json-wb`, ABI option 1 --
`request_value_type` drives the builder's dispatch). It is wired as a `json_wb` layer on every
contract the JS compiler produces (`build_params`/`walk_params`/`build_data`/`walk_data` →
`json_wb:*`) and seeded as a well-known block, so any host can serialize/deserialize a contract's
params/results without TS-specific code. `result.parse()` runs the contract's `walkData` (json-wb)
when present.

What remains (smaller, deferred):
- **Object params still take the host fast path.** `encodeParams` (`src/node/draftPublishing.ts`)
  encodes object params as canonical JSON in TS rather than calling the contract's declared
  `build_params`. This is byte-identical to json-wb's output (proven in `tests/JsonWb.test.ts`), so
  it is a legitimate optimization for JSON contracts -- but a contract with a *non-JSON* declared
  codec would be mis-encoded. To honor arbitrary codecs, route object params through
  `contract.buildParams` when the contract declares one. That requires **async `encodeParams`**: the
  WASM build path is async and `fetch()` returns its handle synchronously today, so thread the
  object-params encode through a deferred-subscription path (keep the bytes path sync).
- **Atomics/JSPI/worker transports**: `request_value_type` / `request_object_keys` are wired through
  the in-process transport (the Deno default) + the host bridge; mirror them into JspiTransport,
  AtomicsWorkerTransport, and wasmInstance for browser parity. (@joel)

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

### Default browser transport plugin (for zero-config `bootstrap`)
`ScaffoldConfig.bootstrap?: string[]` is wired (dialed on `start()` via the configured plugin's
`acceptsProtocols[0]`), but there is no bundled default browser transport, so `bootstrap` requires
the caller to also pass `plugins: [...]`. For true zero-config browser usage
(`new Scaffold({ bootstrap: ['relay.scaffold.io'] })`) we need a default WebRTC/WebSocket transport
plugin that Scaffold installs automatically when `bootstrap` is set and `plugins` is unset. Until
then `start()` throws a clear error directing the user to supply a transport plugin. (@joel)

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

### Verifiable `put()` returns -- DONE
`env.put` resolves the committed sub-block's hash, and generation appends that hash to the block's
`refs`, interleaved with `fetch` refs in call order. Verification consumes `refs` positionally via a
single cursor shared by `fetch` and `put` (`VerifyingEnv`): `fetch` takes the next ref and checks it
claims the requested verifier; `put` returns the next ref. So a contract whose outputs depend on a
put-returned hash (the JS compiler's `env.record(DEFAULT_KEY, hash)`) re-verifies identically. No
wire-format change -- `refs` already existed; genesis unaffected. Covered by
`tests/PutManager.test.ts` ("a block recording the put-returned hash re-verifies") and
`tests/ContractEnv.test.ts` (positional put/fetch replay).

Note: making the JS compiler invokable via network `fetch` (vs local `put`) additionally needs
generation-on-incentive -- a node seeing a fetch incentive block runs the contract locally. That is
the GenerationStrategy / request-routing work below, separate from put verifiability.

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

## Atom Refactor Follow-ups

Every wire packet is now an Atom. `Block`, `SignalAtom`, and
`RequestAtom` extend `AtomBase` and carry hash + raw + reception
metadata + transit metadata (`fromConnections`, `toConnections`).
`JsonSerializer` instances in `Block.ts`, `SignalAtom.ts`, and
`RequestAtom.ts` own both `serialize` and `deserialize`;
`PeerConnection.handleMessage` and `StorageManager.restore` dispatch
off the type byte (`parseHeader`) to the matching serializer.
`Packet<T>` / `composePacket` / `composeUnsignedPacket` /
`parsePacket` are gone, along with the unused `Delivery` and
`PeerInfo` packet types and the `DeliveryTracker` / `RoutingModule`'s
`receivedFirst` / `blockSources` shadow state. Routing reads first
sender directly from the atom; reverse-path signaling
(`SignalAtom.replyTo`) follows the same chain to deliver signals
back to a publisher without flooding. Open work:

- **Unified bandwidth-balanced sender.** Today gossip → routing → NetworkBridge sends blocks immediately. The legacy2 `FactEmitter` pattern (random-sampler weighted by `value/(size + overhead)`) lets every atom kind compete in one pipeline. Move outbound packet selection there; gossip becomes a `value` provider. `block.toConnections` already gives us per-atom outbound dedup; the pipeline can layer on top.
- **`IndexAtom` for cheap announcements.** Mirrors legacy2's `HashInfo`: send the hash of an atom we have, peer sends a `RequestAtom` if it wants the body. Lets the unified pipeline pick between full body and index based on bandwidth budget. `RequestAtom` already exists but has no live producer -- this is its first real consumer.
- **First real consumer of `replyTo`.** The substrate is in place (NetworkBridge routes by `target.fromConnections[0]`, `PeerConnection.sendSignal(... , replyTo)` plumbed) but no caller currently sets `replyTo`. Natural first use: incentive responders include `replyTo: incentiveBlock.hash` so reply signals route back to anonymous publishers.
- **Atom GC respects transit pinning.** Atoms whose `fromConnections` chain is in active use for reverse-path signaling must not be GC'd or the path breaks (current `replyToPathBroken` log path). Once GC lands, "pin while a signal session names this hash" is the simplest policy.
- **`PeerInfoAtom` (return when needed).** The old `PeerInfo` packet type was dead and got deleted. Reintroduce as a proper Atom subtype if/when contract-interest routing (TODO option 4 under "Request Routing") needs peers to advertise which contracts they can execute.

## WASI Shim (user-module, large)

See [`docs/design/wasi-shim.md`](docs/design/wasi-shim.md) for the full design.

The WASI shim is a standalone Zig project that compiles to a single `wasi-shim.wasm` blob. It lives at `src/contracts/wasi-shim/` and is treated like any other user contract module — not part of the scaffold protocol surface. Once shipped, contract authors can run unmodified WASI binaries (compilers, interpreters, etc.) by stacking them above this shim in a `modules` graph.

Prerequisites (land before the shim itself):

- **Multi-memory in `WasmModules.ts` + transports.** Current implementation auto-injects one shared `env.memory`; spec now says each layer owns its own memory and may import others. `WasmModules.ts` needs a two-pass instantiation (topo-sort memory deps, then function-cycle forwarders). All three transports (`InProcessMockTransport`, `JspiTransport`, `AtomicsWorkerTransport`) need updates. Existing tests need to be migrated off the shared-memory shorthand.
- **Contract-trace snapshot testing helper.** `tests/helpers/contractSnapshot.ts` — a general scaffold testing primitive that captures every WASM-boundary event (imports, exports, cross-layer hops, memory reads/writes at the ABI boundary) and snapshots them via `assertSnapshot`. Used by the shim's per-call tests but useful for any contract.

Then the shim itself, in chunks:

- **Per-call reference review.** For each WASI call (~40), reconcile against WASI snapshot preview 1 spec, `bjorn3/browser_wasi_shim`, `wasmtime/crates/wasi-common`, `wasi-libc`, and Zig stdlib's `std.os.wasi`. Document divergences with rationale.
- **VFS in Zig.** `src/contracts/wasi-shim/src/vfs/` — fd table, path resolver, memfs, devfs, input-node abstraction. No WASI-isms, no scaffold-isms. Tested in pure Zig.
- **WASI ABI wire layer.** `src/contracts/wasi-shim/src/abi/` — marshal each WASI call into a vfs operation. Tested in pure Zig.
- **Scaffold wiring.** `src/contracts/wasi-shim/src/scaffold/` — wraps `scaffold_env.*`, reads `wasi_setup`, populates the vfs's input nodes via scaffold callbacks, mediates the cross-memory copy at the boundary. Tested via the contract-trace snapshot helper.
- **`setup.ts` helper.** Build a contract block from `(program WASM hash, wasi_setup)` → modules graph + records. Includes shim blob hash as a constant.
- **`wasi-testsuite` integration.** Vendor as `tests/vendor/wasi-testsuite/`, build harness, filter out unsupported tests with documented reasons.
- **Differential testing against wasmtime.** For each applicable test program, also run via wasmtime locally, diff output.
- **AssemblyScript compiler end-to-end.** Compile a one-liner via `asc` running through the shim; assert output matches a locally-run reference.

### WASI shim — post-v1 follow-ups

- **PRNG seed inputs.** The deterministic PRNG (`random_get`, `/dev/random`, `/dev/urandom`) currently seeds with a 32-byte zero constant — the per-call stream is still deterministic via the shared counter, but two different contract blocks see the same byte sequence. Decide whether the seed should be `H(contract_hash || params)` (matches the old design but recomputes per run), a host-side `scaffold_env.prng_seed()` (separate ABI surface, easier per-block determinism), or some other input. Wire it through `lazy_inputs.zig`-style on-demand fetch so contracts that never touch randomness skip the call. See `src/contracts/wasi-shim/src/abi/random.zig` and `src/contracts/wasi-shim/src/vfs/devfs.zig` for the constants to swap.
- **Production `/out/debug` logger wiring.** `WasmHostBridge` exposes the `debug` flat export across all three transports and `paths.appendDebug` line-buffers correctly, but the production `VerifyingEnv` / `GeneratingEnv` don't implement the optional `ContractEnv.debug` method, so production `/out/debug` writes are dropped silently. Wire a `ScopedLogger` through `ContractHost` (probably via `ContractHostConfig`) so the default envs route to `ctx.logger('contract').debug(...)`. Test envs and the snapshot helper already capture the bytes.
- **`--export=__heap_base` in `build.zig`.** The bump arena currently starts at a hardcoded 2 MiB to dodge the `.rodata` collision Phase E2 found. Long-term cleaner: pass `--export=__heap_base` to wasm-ld and use the linker-provided value. Removes the headroom-vs-collision tradeoff entirely.
- **Wyhash inodes.** `fd_filestat_get` / `path_filestat_get` currently report `ino = 0` for every node. Fine for QuickJS; will break CPython's import cache (which compares inodes for cache invalidation). Upgrade to `Wyhash(canonical_path)` truncated to u64 before the CPython graduation milestone.
- **`OutputLeaf` alignment fragility (`paths.zig`).** The struct has u64 fields that bump its alignment past `vfs.Node`'s natural alignment on wasm32; Zig 0.16's `@fieldParentPtr` requires explicit `@alignCast` at the three recovery call sites. The comment in `OutputLeaf` (which mentions an 8-byte assumption) should be revisited — either re-lay-out the struct to keep alignment ≤ Node's, or adopt the cast pattern as the standard recovery shape across all sibling structs (RecordAccumulator etc. happen to dodge it because their u64 fields fall after natural-aligned fields, but the asymmetry is fragile).
- **`wasi-testsuite` vendoring + harness.** Vendor `WebAssembly/wasi-testsuite` as `tests/vendor/wasi-testsuite/` (git submodule) and build `tests/WasiTestsuite.test.ts` to iterate the test programs through the shim. Filter list TBD; deferred to post-v1.
- **Differential testing against `wasmtime`.** For each test program runnable locally, also run via `wasmtime` and diff stdout/stderr/exit. Lives alongside the wasi-testsuite harness.
- **Larger real-world programs.** PHP (`php-cgi-8.2.6-slim.wasm`), Ruby (`ruby-3.2.2-slim.wasm`), CPython (`python-3.12.0.wasm` — graduation target, gated on the Wyhash inode upgrade above).

## Application Layer

These sit on top of the core protocol and can be specified later.

### Game State Contracts
Deterministic WASM execution for serverless game-state consensus. Dispute/penalty mechanics for incorrect state transitions. The ContractEnv interface (VerifyingEnv/GeneratingEnv) supports the full host function interface needed (requireResult, requireOutput, fetch, collectInputs).

### Content Distribution
Social content from peers with signatures and globally consistent latest-state resolution.

### Marketplace / Escrow
Decentralized marketplaces with escrow and protocol-level resolution/voting.
