# Scaffold v2 Implementation Architecture

## 1. Layers

```
core  ->  node  ->  roles  ->  api
```

- **core** - Pure protocol logic: types, codecs, hashing, claim resolution, validity rules (excluding contract execution), canonical traversal, estimator and penalty math. Lots of pure, functional classes with explicit interfaces.
- **node** - Stateful machinery every peer needs: block store, ingestion funnel, gossip, consensus (fork choice and canonicality), local indexes.
- **roles** - Optional capability modules: author, aggregator, prober, insurer.
- **api** - The public `Scaffold` facade.

I'm not sure where contract execution fits yet.

A lower layer never imports from a higher one.

## 2. Core data model

- **Packet** -- the immutable wire envelope: raw bytes, content hash, type tag, decoded message, optional signature and recovered signer. Frozen at ingestion. All protocol data travels as packets; a block is one packet type.
- **Block** -- per whitepaper §4.1: `anchor`, `chain[]`, `aggregates[]`, `claims[]`, `outputs[]`, `timestampMs`.
- **Node-local state is never stored on the packet or block object.** Each module owns its own index keyed by block hash: reception state in gossip, canonicality in consensus, insurance status in the insurer. No shared mutable records.

## 3. Module/Service pattern

- **Module** (core or role logic): abstract class. Dependencies on other modules are declared as abstract methods -- typed holes the compiler forces every subclass to fill. No context access, no setters, no stored references to other modules.
- **Service** (node wiring): `extends` its module, constructed by the locator. Each abstract method is overridden with a call-time lookup -- `this.ctx.get(OtherService).doSomething(...)` -- never caching the `ctx.get` result at construction. Call-time resolution is what removes construction-order sensitivity.

Hard rules:

1. **A call-graph cycle is a design bug.** Downward dependencies are queries through declared holes; upward dependencies are event subscriptions. If two modules need synchronous queries in both directions, they are one module or hide a third concern to extract. Lazy resolution is for legitimate deferral, not for closing loops cheaply (v1's `computingCanonical` re-entrancy guard is what a runtime cycle looks like).
2. Service constructors are effect-free (wiring only). `NodeContext` does one eager `ctx.get` pass over all services at startup -- safe because lazy method binding makes it order-insensitive. No post-construction setters.
3. A service body is a constructor plus overrides of abstract methods, nothing else. Any other method on a `*Service` is a review flag: protocol logic belongs in the module (the v1 `GenerationService` lesson).
4. Only services touch `ctx`. Modules are constructible and testable without a context (subclass with fake overrides).
5. One reactivity mechanism: typed change events on module boundaries with explicit flush ordering (the `onCanonicalityChange` diff-and-flush pattern). Viz/debug subscribes through a single debounced adapter at the edge; no parallel observer systems.

## 4. Ingestion

A single funnel for local and remote data:

```
bytes -> parse envelope -> dedup by hash -> verify signature -> typed handler -> events
```

- Per-type handlers are registered from config, with transient/persistent/signed dispositions.
- Local emission composes bytes and re-enters the same funnel; there is exactly one code path.
- **Ingestion is commutative:** any ingestion order converges to identical node state. This is a standing property test, not an aspiration.
- Handlers hydrate the envelope only; derived state is computed by modules subscribing to ingestion events.

## 5. Configuration

Three separate objects, injected at construction:

1. **ProtocolParams** -- consensus-critical and network-wide, immutable after construction: α, collateral decay constant, the 60% balance rule, misordering factor, fee curve, `inclusion_prob`. ❓ Possibly committed to by genesis.
2. **NodePolicy** -- local strategy knobs: probe budget λ, risk tolerance, cache and GC limits.
3. **Providers** -- environment: time, entropy, storage, network, logging, contracts, ingestion handlers. Economic curves are injected functions. Deterministic providers (seeded entropy, virtual time) power the simulation harness.

Defaults via `makeDefault*() satisfies Partial<...>` plus spread override. No feature flags that rewrite defaults; tests compose different module sets instead.

## 6. Consensus state

- Fork choice is per-conflict (whitepaper §6.4); canonicality is sampled verified weight minus penalties (§6.3).
- v0 recomputes canonicality on dirty behind a narrow interface -- a deliberate O(N) deferral of the incremental O(log N) design. The interface must not leak the recompute so it can be replaced.
- The UTXO index is maintained incrementally from canonicality change events.
