# TODO v2

Working list for the v2 rewrite. Architecture rationale lives in docs/v2/implementation.md; whitepaper references are `wp §`.

## Blocking decisions (gate the block codec)

- [ ] Define "size" for the anchor constraint and 60% balance rule (wp §4.2, App. D)
- [ ] `declaredWeights`: separate block field vs reuse of aggregation fees (wp §6.2)
- [ ] Gap-freezing: snapshot child weights into aggregation blocks? (wp App. C, resolve-before-implementation)
- [ ] Structural coverage: require an insurance output on every aggregation? (wp §8.2)
- [ ] Misordering penalty: commit to hinge U vs simple `throughput * factor` (wp §5.4, App. C)

## Patterns to adopt (2026-07-21 architecture review)

- [ ] Config split: ProtocolParams (immutable, consensus-critical) / NodePolicy / Providers; economic curves as injected functions; no runtime config mutation; no default-rewriting feature flags
- [ ] Keep the `BaseContext` service locator; revive the legacy2 `TestContext` allowlist
- [ ] Packet envelope: immutable wire record; node-local state in per-module indexes keyed by hash (no `FactBase`/`BlockMeta` god-records)
- [ ] Single ingestion funnel; local emission re-enters it; ingestion commutativity as a standing property test
- [ ] Module/Service: abstract modules declare dependencies as abstract methods; services override with call-time `ctx.get` (no caching, no setters); service bodies are constructor + overrides only
- [ ] One reactivity mechanism: typed change events with explicit flush ordering; single debounced viz adapter at the edge
- [ ] Code names track wp Appendix D glossary (weight / throughput / size)
- [ ] Test seams: core tested directly, integration through the `Scaffold` facade (v1 has ~119 test files importing src internals, making reshuffles expensive)

## Initial build order

1. [ ] Pure core: hash/codec, `Block` type, `resolveClaim` + output space (property-test vs wp §4.5 generative spec), validity rules (wp §5.1), canonical traversal (wp §4.4), `Estimate` algebra (wp §6.2), hinge penalty (wp App. C test vectors)
2. [ ] Store + ingestion funnel + event mechanism; commutativity property test
3. [ ] Consensus: conflict detection, per-conflict fork choice, canonicality with penalties (recompute-on-dirty v0 behind a narrow interface)
4. [ ] Roles: author, aggregation building + merkle mask (wp §4.6), sampling/probing, insurance/collateral
5. [ ] Economics simulation harness; validate against wp App. E equilibrium numbers

## Known gaps / deferrals

- [ ] Canonicality recompute is O(N) in v0; incremental O(log N) later (the interface must allow the swap)
- [ ] Delete `src/core/CoreContext.ts` (dead stub) when cutting over old code
- [ ] docs/v2/scaffold.md is still empty; fill once the facade API firms up
