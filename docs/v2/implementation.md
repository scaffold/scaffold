# Scaffold v2 Implementation Architecture

## Layers

```
logic/  <-  graph/  <-  contract/  <-  peer/  <-  roles/  <-  api/
```

- **logic/** - Protocol logic with no wiring: pure walks, codecs, and abstract modules whose injected dependencies are declared as abstract methods. The membership test is types, not abstractness -- a logic/ module must not import the Block / Draft interfaces, only its own structural subset types and the node kind tags. Should not import Context. Testable with hand-built literals. TODO: Move this to graph/ as *Base.ts files?
- **graph/** - Everything required to maintain the Block / Draft node graph, and gives peer/ the tools it needs to monitor the canonical state and react to changes. Context-wired services, which may be concretized extensions of logic/ modules. Should contain as little logic as possible. An abstract module that reads Block / Draft fields belongs here, next to its service, not in logic/. Contains in-memory state of the graph. Testable using a test context.
- **contract/** - Everything related to contract execution.
- **contract/static/** - Well-known contracts defined in TypeScript.
- **contract/wasm/** - Machinery supporting WASM contract execution.
- **contract/wasm/worker/** - Code running in the WASM worker thread.
- **peer/** - Stateful machinery every peer needs: block persistence, ingestion funnel, execution, gossip. Named peer/ rather than node/ because a Node is a graph node (`Block | Draft`).
- **roles/** - Optional capability modules: author, aggregator, prober, insurer.
- **api/** - The public `Scaffold` facade.

Each of these is a directory inside src/. A lower layer never imports from a higher one. util/ sits below
logic/ and holds language-level helpers with no protocol knowledge. `Config` and `Context` sit at the src/
root as the composition root: every layer may import them, and they are exempt from the ordering.

Additionally, this files in each of these can be parititoned into XyzBase.ts and Xyz.ts files. Roughly, the `Base` classes should be abstract and hold most of the logic, calling dependencies via abstract methods. They should have minimal interfaces and be easily testable. The non-`Base` classes are concrete and connected with the rest of the system, typically via `Context`. They should hold as little logic as possible, and are typically tested in higher-level integration tests.

Filenames carry no `Module` / `Service` suffix, and neither does the wired class: the name every caller
reaches for is a bare noun, so `ctx.get(...)` reads the same for all of them -- `ctx.get(BlockStore)`,
`ctx.get(Forest)`, `ctx.get(Placement)`. Only the logic/ half of a pair is suffixed, with `Base`, because
that is the one place the two halves must be told apart: `logic/Placement.ts` exports `PlacementBase`,
`graph/Placement.ts` exports `Placement extends PlacementBase`. A concept with no logic/ half is just the
bare noun (`BlockStore`, `ClaimIndex`). tests/ mirrors the same directories.

Potential other naming: `Plugin` / `Service`

## Core data model

- **Packet** -- the immutable wire envelope: raw bytes, content hash, type tag, decoded message, optional signature and recovered signer. Frozen at ingestion. All protocol data travels as packets; a block is one packet type.
- **Block** -- per whitepaper §4.1: `anchor`, `chain[]`, `aggregates[]`, `claims[]`, `outputs[]`, `timestampMs`.
- **Node-local state is never stored on the packet or block object.** Each module owns its own index keyed by block hash: reception state in gossip, canonicality in consensus, insurance status in the insurer. No shared mutable records.

## Module/Service pattern

The pattern keeps the names Module and Service; the classes are suffixed `Base` / unsuffixed per the
naming rule above.

- **Module** (`XBase`, core or role logic): abstract class. Dependencies on other modules are declared as abstract methods -- typed holes the compiler forces every subclass to fill. No context access, no setters, no stored references to other modules.
- **Service** (`X`, node wiring): `extends` its module, constructed by the locator. Each abstract method is overridden with a call-time lookup -- `this.ctx.get(Other).doSomething(...)` -- never caching the `ctx.get` result at construction. Call-time resolution is what removes construction-order sensitivity.

Hard rules:

1. **A call-graph cycle is a design bug.** Downward dependencies are queries through declared holes; upward dependencies are event subscriptions. If two modules need synchronous queries in both directions, they are one module or hide a third concern to extract. Lazy resolution is for legitimate deferral, not for closing loops cheaply (v1's `computingCanonical` re-entrancy guard is what a runtime cycle looks like).
2. Service constructors are effect-free (wiring only). `NodeContext` does one eager `ctx.get` pass over all services at startup -- safe because lazy method binding makes it order-insensitive. No post-construction setters.
3. A service body is a constructor plus overrides of abstract methods, nothing else. Any other method on a service is a review flag: protocol logic belongs in the module (the v1 `GenerationService` lesson).
4. Only services touch `ctx`. Modules are constructible and testable without a context (subclass with fake overrides).
5. One reactivity mechanism: typed change events on module boundaries with explicit flush ordering (the `onCanonicalityChange` diff-and-flush pattern). Viz/debug subscribes through a single debounced adapter at the edge; no parallel observer systems.

## Ingestion

A single funnel for local and remote data:

```
bytes -> parse envelope -> dedup by hash -> verify signature -> typed handler -> events
```

- Per-type handlers are registered from config, with transient/persistent/signed dispositions.
- Local emission composes bytes and re-enters the same funnel; there is exactly one code path.
- **Ingestion is commutative:** any ingestion order converges to identical node state. This is a standing property test, not an aspiration.
- Handlers hydrate the envelope only; derived state is computed by modules subscribing to ingestion events.

## Configuration

Three separate objects, injected at construction:

1. **ProtocolParams** -- consensus-critical and network-wide, immutable after construction: α, collateral decay constant, the 60% balance rule, misordering factor, fee curve, `inclusion_prob`. ❓ Possibly committed to by genesis.
2. **NodePolicy** -- local strategy knobs: probe budget λ, risk tolerance, cache and GC limits.
3. **Providers** -- environment: time, entropy, storage, network, logging, contracts, ingestion handlers. Economic curves are injected functions. Deterministic providers (seeded entropy, virtual time) power the simulation harness.

Defaults via `makeDefault*() satisfies Partial<...>` plus spread override. No feature flags that rewrite defaults; tests compose different module sets instead.

## Consensus state

- Fork choice is per-conflict (whitepaper §6.4); canonicality is sampled verified weight minus penalties (§6.3).
- v0 recomputes canonicality on dirty behind a narrow interface -- a deliberate O(N) deferral of the incremental O(log N) design. The interface must not leak the recompute so it can be replaced.
- The UTXO index is maintained incrementally from canonicality change events.

## Block creation

Block creation involves choosing an anchor based on the set of blocks that need to be included, and the set of blocks being aggregated. The inclusion set comes from claims, refs, and aggregate anchors.

1. Enumerate the aggregation set of each inclusion. The aggregation set is produced by recursively getting all the aggregators of a block, adding them to the set, and recursing. This isn't necessarily a chain because a block can have multiple aggregations, but generally at each level one quickly wins and the other competing aggregations won't get re-aggregated, so the aggregation set has size O(log N).
2. Eliminate inclusions whose chain includes a block we are aggregating. These are included in the new block's reach via aggregation, and won't influence the anchor.
3. For the remaining chains, enumerate all blocks in every chain. Find one whose anchor chain intersects with every inclusion chain. If there are multiple, you may use a hueristic to decide which one to select as your anchor. If there are none, that means you are trying to include blocks in 2 unaggregated subtrees, so you either need to aggregate them immediately or wait for them to be aggregated.

This method relies on an external process aggregating, either locally or remotely. An alternate approach would be to aggregate subtree roots on-demand. This was considered but rejected because (1) aggregation is disabled by light clients, and (2) aggregation has some specific rules about subtree size, so it's not possible to fix every case. Ultimately, it seems better to have a single aggregation path and have block creation wait for that to complete.

## Node ingestion procedure

A strict procedure is necessary to ensure that observers see a consistent node graph.

1. Block/Draft deserialization or creation, optionally referencing a BlockRef.
2. Linking and claim propagation. Connect the new node's properties with existing nodes, and existing node's properties with the new node. If replacing a BlockRef, this should update all references to the BlockRef with the new Block. Do not call any listeners or invoke any code paths that expect a consistent graph.
3. Notify listeners.

TODO: How can we verify that the old BlockRef was entirely replaced and will be garbage collected? If we miss a link somewhere, this will cause bugs because both a BlockRef and Block with the same hash will exist in the graph.

When promoting a Draft to a Block:

1. Serialize the Block
2. Linking and claim propagation
3. Mark the Draft as built
4. Notify new Block listeners
5. Notify old Draft listeners
