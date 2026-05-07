# Subsystem Categorization Draft

A first-pass mapping of every file in `src/core/` to one of the proposed subsystems
(Executor, Forest, Canonicality, Construction, Store), plus a `Shared` bucket for
data structures and wire-format files that aren't really a subsystem and a `Top-level`
bucket for the orchestration glue.

| File | Subsystem | Notes |
|------|-----------|-------|
| `Block.ts` | Shared | Block data structure + `BlockStore`. Consumed by every subsystem. |
| `BlockSerializer.ts` | Shared | Wire serialization. |
| `Atom.ts` | Shared | Wire-format atom type. |
| `Packet.ts` | Shared | Wire-format packet type. |
| `PacketSerializer.ts` | Shared | Wire serialization. |
| `SignalAtom.ts` | Shared | Wire-format signal atom. |
| `RequestAtom.ts` | Shared | Wire-format request atom. |
| `Draft.ts` | Shared | Draft data structure + `DraftStore`. |
| `Node.ts` | Shared | Unified vertex interface (Block + Draft). |
| `SparseMask.ts` | Shared | Bitmask utility used by output-space and aggregation. |
| `BlockCreationModule.ts` | Shared | Defines `Output`, `Verifier`, `BlockSpec`, `ClaimEntry`, plus throughput-balance validation. The types are used everywhere, but the validation logic itself is Construction. |
| `OutputSpace.ts` | Shared | Pure functions over claim masks + extended vector. Consumed by Canonicality (claim/anchor propagation) and Construction (BlockBuilder). |
| | | |
| `ExecutionQueueModule.ts` | Executor | Priority queue of executable tasks. |
| `ExecutionQueueService.ts` | Executor | Service wiring. |
| `ContractHost.ts` | Executor | Runs WASM contracts under a host environment. |
| `ContractHostService.ts` | Executor | Service wiring. |
| `ContractEnv.ts` | Executor | Env interface shared by generation + verification. |
| `GeneratingEnv.ts` | Executor | Generation env. |
| `VerifyingEnv.ts` | Executor | Verification env. |
| `ContractVerificationModule.ts` | Executor | Verifies a single contract execution. |
| `ContractVerificationService.ts` | Executor | Service wiring. |
| `BlockVerificationModule.ts` | Executor | Verifies a whole block (drives ContractVerification + namespace partition). |
| `BlockVerificationService.ts` | Executor | Service wiring. |
| `NamespacePartitionModule.ts` | Executor | Structural-verification rule for output namespaces; called from block verification. |
| `WasmStore.ts` | Executor | Stores compiled WASM contracts. |
| `RecordingWalkerHost.ts` | Executor | Output-recording helper used during execution. |
| `DefaultBuilderHost.ts` | Executor | Default host implementation for the builder/generator. |
| `OutputHandlerRegistry.ts` | Executor | Fallback chain for `getOutput` resolution during generation. |
| `builtinResolvers.ts` | Executor | Built-in `getOutput` resolvers (UTXO, blob registry). |
| | | |
| `SamplingModule.ts` | Forest | Samples the graph to pick which subtree to verify next. |
| `SamplingService.ts` | Forest | Service wiring. |
| `NodeWeightsModule.ts` | Forest | Weight propagation across the DAG (weight vectors, descendant weight). |
| `NodeWeightsService.ts` | Forest | Service wiring. |
| `TrustModule.ts` | Forest? / Litigation? | Tracks collateral placements (for/against). Affects effective trust on a block. **Possibly belongs outside core under "litigation"** as you mentioned — it's pure bookkeeping today, no propagation hooks yet. Flagging for discussion. |
| `TrustService.ts` | Forest? / Litigation? | Service wiring; same uncertainty. |
| | | |
| `ConsensusModule.ts` | Canonicality | The canonicality engine: parent-priority + conflict resolution by effective weight. |
| `ConsensusService.ts` | Canonicality | Service wiring. |
| `OutputClaimModule.ts` | Canonicality | Tracks claims, detects conflicts, migrates claim refs as ancestors land — drives canonicality input. |
| `OutputClaimService.ts` | Canonicality | Service wiring. |
| `AnchoringModule.ts` | Canonicality | Resolves output positions through the anchor chain after claim removal — pure structural propagation, no construction. |
| | | |
| `BlockBuilderModule.ts` | Construction | The single place blocks come into existence (claim lowering, signing). |
| `BlockCreationService.ts` | Construction | Service wiring around BlockBuilder. |
| `DraftManager.ts` | Construction | Draft lifecycle: create, register with consensus, dispatch generator, cancel on margin loss. |
| `Generator.ts` | Construction | `GeneratorProvider` interface + stub. |
| `DraftPlacement.ts` | Construction | Caller-side helper that calls `PlacementModule` for drafts. Used by BlockBuilder, ConsensusService, and NodeWeightsService -- centralizes the call so all three agree on a draft's anchor. |
| | | |
| `PlacementModule.ts` | Canonicality (shared edge) | Computes a node's anchor + aggregates from the canonical-aggregator view. Called from Construction (BlockBuilder), Canonicality (ConsensusService), and Forest (NodeWeightsService). Lives on the Canonicality side because it *consumes* canonical state; the others read it. |
| `PlacementService.ts` | Canonicality (shared edge) | Service wiring; same placement, with a cycle-break for draft-of-self queries. |
| | | |
| `Coordinator.ts` | Top-level / Store | Two-event orchestrator wiring all the modules together. Closest match to your `StoreProvider`. |
| `ProtocolContext.ts` | Top-level / Store | DI + logger plumbing. |
| `EventLog.ts` | Top-level / Store | Ring buffer + scoped logger; cross-cutting. |

## Counts per subsystem

- **Shared (data + wire):** 12
- **Executor:** 16
- **Forest:** 4 (or 2 if Trust moves out)
- **Canonicality:** 7 (5 core + 2 placement at the edge)
- **Construction:** 5
- **Top-level (Store-ish):** 3

## Things to discuss

1. **`BlockCreationModule.ts` is two things in one file.** The type definitions
   (`Output`, `Verifier`, `BlockSpec`, `ClaimEntry`) are foundational shared types,
   but `validateThroughputBalance` is a Construction-side check. If we split per
   subsystem we'd want to peel the types out into a `BlockTypes.ts` and leave the
   throughput validation in Construction.

2. **`OutputSpace.ts` straddles Canonicality and Construction.** Pure functions —
   no state — but consumed by both BlockBuilder (extended vector) and
   AnchoringModule (claim mask propagation). I left it in `Shared`; alternatively
   it could live with Canonicality and be imported by Construction.

3. **`PlacementModule` / `PlacementService` / `DraftPlacement` straddle three
   subsystems.** Placement reads canonical state and is called from Construction
   (BlockBuilder), Canonicality (ConsensusService), and Forest (NodeWeightsService).
   The cycle-break in `PlacementService` -- "skip node X while computing the
   canonical view for X's own placement" -- is a subtle coupling between
   placement and weight propagation that any subsystem boundary needs to preserve.
   Owner candidates: (a) Canonicality (consumes canonical state, the others read);
   (b) its own micro-subsystem; (c) Shared. Currently in Canonicality (a).

4. **`TrustModule` placement.** Today it's pure storage/bookkeeping for collateral
   placements. Doesn't propagate, doesn't decide canonicality. You said "everything
   else is litigation" — Trust feels closer to that than to Forest. But if collateral
   eventually feeds into effective weight, Forest is right. Depends where you take
   the design.

5. **Verification straddles Executor and Canonicality.** `BlockVerificationModule`
   is gated by sampling priority (Forest) and produces `verified=true`/`false` which
   feeds canonicality. I put it in Executor since it *runs* verification, but the
   subsystem boundary needs a clear answer to "who calls verify and consumes the
   result." Today: Coordinator does. Under the new model: probably the Forest's
   `update(ref)` triggers an Executor task, whose result feeds Canonicality.

6. **Coordinator vs StoreProvider.** Your sketch's `StoreProvider.ingest(block)`
   is roughly today's `Coordinator.processBlockReceived`. `build(draft)` maps to
   the DraftManager → BlockBuilder path. Worth confirming: does `StoreProvider`
   own the actual block/draft store, or just orchestrate the four child providers
   that share access to it?
