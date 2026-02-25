# Project Anatomy

## What Scaffold is (in code)

Scaffold is a signed fact graph where blocks claim prior outputs, produce new outputs, and get rewritten through conflict resolution rather than hard immediate finality.

The two central design choices are:

- Optimistic first, adjudication later.
- Merge many branches through tree-style aggregation, so a node can reason from paths/subtrees instead of scanning a linear chain.

## Core runtime components

- `FactService`: ingestion, signing, storage, identity recovery, and fact lifecycle.
- `BlockIngestor`: block-level validity gates, IO linking, verifier launch triggers, canonicality refresh.
- `BlockBuilder`: local block construction, balance closure, grouping, frontier/squash linking.
- `FrontierService` + `FrontierService3`: aggregation link building and UTXO index rebasing.
- `BlockService`: claim/conflict propagation, mergeability checks, block queries, verification waits.
- `BlockMetrics`: canonical winner and chain score metrics.
- `CanonicalityService`: keeps `AvailableOutputManager` aligned with canonical/unclaimed outputs.
- `FetchService`: requester-facing API (publish incentive, watch fulfilling blocks/bodies).
- `OrchestrationService`: runs generators/verifiers (local providers or wasm workers).

## Fact types on wire

- Persistent signed: `Block`, `PeerInfo`, `ConnectionSignal`.
- Transient unsigned: `Index`.

## End-to-end execution loop

1. A requester calls `FetchService.fetch(verifier, options)`.
2. If no matching block is known, a deposit-like incentive output is published.
3. Canonical unclaimed outputs are surfaced in `AvailableOutputManager`.
4. `BlockIngestor` sees an unclaimed output and asks `OrchestrationService` to launch a generator.
5. Generator publishes a new block through `BlockBuilder` and `BlockService.create`.
6. New block ingestion links inputs, updates claims/conflicts, and launches verifier tasks per verifier group.
7. `BlockMetrics` recomputes winners; `CanonicalityService` mutates output availability.
8. `FetchService` callbacks get newer canonical matching bodies.

## Why the tree matters

Every block stores:

- one `parent` vote,
- zero or more `squashes` (aggregated subtree roots),
- `squashedUtxoIdxs` rebased to the selected parent space.

This turns the global spend set into recursively composable local transformations. The intended result is path-sized reasoning (towards `O(log N)` under enforced growth constraints), not full-history scans.
