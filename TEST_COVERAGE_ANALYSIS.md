# Test Coverage Analysis

## Overview

| Metric | Value |
|--------|-------|
| Total Source Files | 107 |
| Total Test Files | 31 |
| Total Test Cases | ~445 |
| Source Lines of Code | ~12,013 |
| Test Lines of Code | ~441 |
| Modules with Direct Tests | ~25/107 (23%) |

The test suite has **strong coverage of core protocol modules** (consensus, conflict, gossip, sampling, trust) but **significant gaps** in contracts, utilities, worker code, and some critical infrastructure.

---

## Current Test Quality Assessment

### Well-Tested Modules (Excellent coverage)

| Module | Tests | Notes |
|--------|-------|-------|
| GossipModule | 60+ | Formula correctness, delivery matrix, decay, integration flows |
| ConflictModule | 30 | BitVector ops, three-way conflicts, rebasing, partial knowledge |
| TrustModule | 30+ | Full collateral lifecycle, weight calculations, claim limits |
| ConsensusModule | 24 | Weight resolution, aggregation, tie-breaking, propagation |
| SamplingModule | 28+ | Distribution stats, priority formulas, fraud deprioritization |
| BlockCreationModule | 22 | Validation, throughput, claim masks, aggregation |
| PeerConnection | 25+ | All message types, serialization round-trips, error handling |

### Adequately Tested Modules (Good but could be improved)

| Module | Tests | Gaps |
|--------|-------|------|
| FetchManager | 18 | Missing transport failure scenarios |
| AggregationStrategy | 12 | Missing complex multi-anchor scenarios |
| DeliveryTracker | 13 | No concurrent access tests |
| GarbageCollector | 11 | No stress/performance tests |
| GenerationStrategy | 15 | Limited slot management edge cases |
| ContractExecutor | 10 | No in-contract error handling tests |

### Under-Tested Modules (Need immediate attention)

| Module | Tests | Gaps |
|--------|-------|------|
| **Scaffold** | 6 | Main API — no error scenarios, no conflict interactions, no multi-put sequences |
| **StorageManager** | 8 | No I/O failure tests, no concurrent operation tests |
| **SyncProtocol** | 8 | No deep ancestry traversal, no partial sync tests |
| **NetworkManager** | 9 | No transport failure tests, no reconnection tests |
| **ContractValidator** (demo) | 4 | Only tests signer — no malformed block or claim validation tests |

---

## Untested Modules — Prioritized Recommendations

### Priority 1: Critical Core Infrastructure (No tests at all)

#### 1. `src/core/Block.ts` — BlockStore
- **Why**: Foundation data structure for the entire protocol. `BlockStore` manages all blocks, tracks aggregation, and computes ancestry. Any bug here cascades everywhere.
- **What to test**: `isAncestor()` traversal, `getAnchorDepth()`, `isAggregated()`, `createBlock()` hash computation, `createGenesisBlock()`, aggregation data encoding/decoding.
- **Effort**: ~20-25 tests

#### 2. `src/core/BlockSerializer.ts`
- **Why**: Serialization correctness is critical for persistence and network transport. Type-tagged encoding for Hash, Uint8Array, bigint, and BitVector must round-trip perfectly.
- **What to test**: Round-trip serialize/deserialize for each type, nested structures, edge cases (empty arrays, zero values, max bigints).
- **Effort**: ~10-15 tests

#### 3. `src/core/Coordinator.ts`
- **Why**: Central orchestrator that drives the 6-step block processing pipeline. Bugs here affect all protocol modules.
- **What to test**: `blockReceived()` pipeline with valid/invalid blocks, `attemptAggregation()`, canonical view diffing, error propagation from sub-modules.
- **Effort**: ~15-20 tests

#### 4. `src/util/Hash.ts`
- **Why**: Core cryptographic primitive. Every block hash, identity, and comparison flows through this class.
- **What to test**: `digest()` / `digestParts()` correctness with known vectors, conversion round-trips (bytes ↔ hex ↔ bigint ↔ fraction), `xor`/`add`/`equals`/`compare` operations, edge cases (zero hash, max hash).
- **Effort**: ~20 tests

### Priority 2: Important Algorithms and Data Structures

#### 5. `src/util/RandomSampler.ts`
- **Why**: Weighted binary heap used for probability-based sampling. 20+ methods with intricate heap invariant maintenance. Bugs cause biased or broken sampling.
- **What to test**: Weighted insert/remove, sampling distribution, heap invariant maintenance (`countHeapViolations`), edge cases (single element, all same weight).
- **Effort**: ~15 tests

#### 6. `src/util/maxClique.ts`
- **Why**: NP-hard solver used for consensus weight calculations. Incorrect results directly affect canonical view.
- **What to test**: Known graph inputs with known max cliques, empty graph, complete graph, disconnected components, performance on larger inputs.
- **Effort**: ~10 tests

#### 7. `src/util/MessageSplitter.ts` (MessageSplitter + MessageJoiner)
- **Why**: Network packet fragmentation and reassembly. Bugs cause silent data corruption or message loss.
- **What to test**: Messages below/above threshold, multi-chunk reassembly, out-of-order fragments, timeout cleanup, concurrent messages.
- **Effort**: ~12 tests

#### 8. `src/core/BitVector.ts`
- **Why**: Already tested within ConflictModule.test.ts (11 tests), but deserves dedicated coverage for the `rebase()` algorithm and partial knowledge semantics.
- **What to test**: Rebase with various output mask shapes, chunk boundary edge cases, unknown chunk interactions, large vectors.
- **Effort**: ~15 tests (dedicated file)

### Priority 3: Service Layer Gap

The core module tests cover the algorithms well, but the **service wrappers** that integrate modules with external I/O are completely untested:

#### 9. `src/core/*Service.ts` (6 files)
- `BlockCreationService.ts`, `ConflictService.ts`, `ConsensusService.ts`, `GossipService.ts`, `SamplingService.ts`, `TrustService.ts`
- **Why**: These bridge the pure-logic modules to the rest of the system. They handle state management, I/O coordination, and error boundaries.
- **What to test**: Service initialization, delegation to modules, error handling at boundaries, state lifecycle.
- **Effort**: ~5-8 tests per service

### Priority 4: Contract Implementations

All 13 contract files in `src/contracts/` lack tests:

#### 10. Key contracts to prioritize:
- **CollateralContract.ts** — Sorting and validation logic, most complex contract
- **DataContract.ts** — Cryptographic validation of data claims
- **CollatzContract.ts** — Recursive computation contract
- **AccountContract.ts** — Account state management
- **Why**: Contracts define protocol behavior. Incorrect contract logic means incorrect state transitions.
- **Effort**: ~5-10 tests per complex contract, ~3-5 per simple one

### Priority 5: Worker/WASM Subsystem

The entire `src/worker/` directory (20 files) is untested:

#### 11. Key worker files to prioritize:
- **WasiImpl.ts** (~1000+ lines) — Full WASI implementation, extremely complex
- **Instance.ts** — WASM instantiation and memory management
- **WorkerChannel.ts** — Inter-thread messaging with atomics
- **MemFs.ts** — In-memory filesystem
- **Why**: If WASM execution is used, bugs here cause silent computation errors.
- **Note**: These require runtime-specific mocking and are harder to test.
- **Effort**: Significant — 50+ tests across the subsystem

---

## Existing Test Quality Issues

### 1. Test depth is shallow in some files
The ~441 lines of test code across 31 files averages to ~14 lines per file. Several test files are extremely thin — some have only a single assertion per test case. Compare this to the ~12,000 lines of source code (a 27:1 ratio).

### 2. Error paths are under-tested
Most tests verify happy paths. Error scenarios — invalid inputs, network failures, I/O errors, concurrent access violations — are rarely tested. This is especially concerning for:
- `Scaffold.ts` (main API, 0 error tests)
- `NetworkManager.ts` (no transport failure tests)
- `StorageManager.ts` (no I/O failure tests)

### 3. No property-based testing
Algorithmic modules like BitVector, RandomSampler, and maxClique would benefit from property-based / fuzz testing to catch edge cases that hand-written tests miss.

### 4. Integration test coverage is minimal
Only `Integration.test.ts` (9 tests) covers multi-module interactions. The protocol's correctness depends on module composition, which is barely tested.

### 5. CI pipeline doesn't run tests
Both lint and test steps are **commented out** in `.github/workflows/deno.yml`. Tests are not enforced in CI.

---

## Recommended Action Plan

| Phase | Action | Impact |
|-------|--------|--------|
| **1** | Add tests for Block.ts, BlockSerializer.ts, Hash.ts, Coordinator.ts | Covers critical foundations |
| **2** | Expand Scaffold.test.ts with error + conflict scenarios | Protects main API surface |
| **3** | Add tests for RandomSampler, maxClique, MessageSplitter | Covers important algorithms |
| **4** | Add dedicated BitVector.test.ts | Strengthens conflict detection |
| **5** | Add error-path tests to NetworkManager, StorageManager, SyncProtocol | Improves resilience coverage |
| **6** | Add service-layer tests for *Service.ts files | Closes module-to-system gap |
| **7** | Add contract tests (CollateralContract, DataContract, etc.) | Covers protocol behavior |
| **8** | Enable lint + test in CI pipeline | Enforces quality going forward |
| **9** | Add integration tests for multi-node scenarios | Validates system correctness |
| **10** | Explore property-based testing for algorithms | Catches edge cases |
