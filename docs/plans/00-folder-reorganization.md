## Summary

Move files into `src/core/`, `src/node/`, `src/util/`, `src/contracts/`, `src/worker/`, `src/demo/`, `plugins/`, `legacy2/`. The core/ directory contains all pure protocol modules. node/ contains internal wiring. Everything else from src/ that isn't in the new structure goes to legacy2/.

## Dependencies

None (do this first).

## Design

- `src/core/` gets: Block.ts, BitVector.ts, BlockSerializer.ts, all 6 *Module.ts, all 6 *Service.ts (protocol ones), Coordinator.ts, ProtocolContext.ts
- `src/util/` gets: all files from src/util/ plus BaseContext.ts
- `src/contracts/` stays as-is
- `src/worker/` stays as-is
- `src/demo/` stays as-is
- `src/node/` starts empty (will be built in subsequent tasks)
- `src/types.ts` for shared types (Verifier, Output re-exports)
- `src/Scaffold.ts` the public API (built later)
- `legacy2/` gets everything else from src/ root: FactService, BlockService, BlockBuilder, FetchService, PutService, Config, Context, CanonicalityService, ConnectionService, Connection, NetworkService, NetworkProvider, SignalingService, RoutingService, RoutingService2, MonitoringService, OrchestrationService, GenerationDriver, VerifiationDriver, WorkerManager, WorkerDriver, ConstraintService, FrontierService, FrontierService3, FrontierMonitorService, MergeabilityService, LitigationService, LocalGeneratorService, ResponseService, GarbageCollectionService, CollateralUtil, collateralMessages, HintSuggestionService, SpecialContractManager, WalkerService, KnowledgeMonitor, EmitQueue, FactEmitter, FactMeta, BlockMeta, BlockMetrics, ComputationMeta, DataService, DataTreeHelper, DataTreeOverlay, PeerManager, QaService, Query, RenderService, SnapshotHelper, SnapshotService, SpendMaskBitmaskHelper, StateTracker, AvailableOutputManager, BalanceService, ContractClassifierService, GenesisService, WorkerDebuggerManager, PoissonInterval, ClockService, Logger, Logger2, FingerprintSet, TestContext, constants, exceptions, hashes, messages, protocol/base.ts, protocol/channel.ts, ingestors/, record_sets/
- `plugins/` stays at top level (already separate)

## Interface

No new interfaces. This is a pure file-move operation with import path updates.

## Implementation Notes

- Update all import paths in moved files.
- Run tests to verify nothing breaks.
- This is a pure mechanical move.

## Testing

All existing tests should pass after import path updates.
