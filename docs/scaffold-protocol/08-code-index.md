# Code Index (Primary Sources)

This index maps each protocol subsystem to its key source files.

## Core message and wire definitions

- `scaffold/src/protocol/base.ts`
- `scaffold/src/protocol/channel.ts`
- `scaffold/src/messages.ts`
- `scaffold/src/collateralMessages.ts`

## Fact ingestion and lifecycle

- `scaffold/src/FactService.ts`
- `scaffold/src/IngestionProvider.ts`
- `scaffold/src/ingestors/BlockIngestor.ts`
- `scaffold/src/ingestors/PeerInfoIngestor.ts`
- `scaffold/src/ingestors/ConnectionSignalIngestor.ts`
- `scaffold/src/ingestors/IndexIngestor.ts`

## Block construction and aggregation

- `scaffold/src/BlockBuilder.ts`
- `scaffold/src/FrontierService3.ts`
- `scaffold/src/FrontierService.ts`
- `scaffold/src/WalkerService.ts`
- `scaffold/src/constants.ts`

## Conflict, mergeability, canonicality

- `scaffold/src/BlockService.ts`
- `scaffold/src/MergeabilityService.ts`
- `scaffold/src/BlockMetrics.ts`
- `scaffold/src/CanonicalityService.ts`

## Execution and orchestration

- `scaffold/src/FetchService.ts`
- `scaffold/src/OrchestrationService.ts`
- `scaffold/src/GenerationDriver.ts`
- `scaffold/src/VerifiationDriver.ts`
- `scaffold/src/ComputationMeta.ts`

## Incentives and collateral

- `scaffold/src/CollateralUtil.ts`
- `scaffold/src/LitigationService.ts`
- `scaffold/src/contracts/CollateralContract.ts`
- `scaffold/src/contracts/AccountContract.ts`
- `scaffold/src/contracts/RootContract.ts`
- `scaffold/src/contracts/TimeContract.ts`
- `scaffold/src/contracts/FrontierContract.ts`

## Networking and propagation

- `scaffold/src/Connection.ts`
- `scaffold/src/ConnectionService.ts`
- `scaffold/src/NetworkService.ts`
- `scaffold/src/SignalingService.ts`
- `scaffold/src/RoutingService.ts`
- `scaffold/src/FactEmitter.ts`
- `scaffold/src/PeerManager.ts`

## Useful tests

- `scaffold/tests/utxoSet.test.ts`
- `scaffold/tests/utxoSet.2.test.ts`
- `scaffold/tests/collateral.test.ts`
- `scaffold/tests/contracts/FrontierContract.test.ts`
- `scaffold/tests/contracts/CollateralContract.test.ts`
