# TODO v2

## Joel's TODOs

- Genesis block
- Draft -> block
- UTXO -> drafting
- Special rules for aggregation grouping for now. Simple aggregation (ignore risk etc)
- Draft prioritization via descendant weight sampling
- Generic generator / verification hook
- Network send / receive (global flooding for now)

## Blocking decisions (gate the block codec)

- [ ] Define "size" for the anchor constraint and 60% balance rule (wp §4.2, App. D). Note wp §4.2's own weight example contradicts a strict reading: B1 anchors B0 with both leaves, so "must point to a larger tree" cannot mean strictly-larger-at-publication. Anchor selection can't be written until this is pinned
- [ ] `declaredWeights`: separate block field vs reuse of aggregation fees (wp §6.2)
- [ ] Gap-freezing: snapshot child weights into aggregation blocks? (wp App. C, resolve-before-implementation)
- [ ] Structural coverage: require an insurance output on every aggregation? (wp §8.2)
- [ ] Misordering penalty: commit to hinge U vs simple `throughput * factor` (wp §5.4, App. C)

## Patterns to adopt (2026-07-21 architecture review)

- [ ] Keep the `BaseContext` service locator; revive the legacy2 `TestContext` allowlist
- [ ] Single ingestion funnel; local emission re-enters it; ingestion commutativity as a standing property test
- [ ] Module/Service: abstract modules declare dependencies as abstract methods; services override with call-time `ctx.get` (no caching, no setters); service bodies are constructor + overrides only
- [ ] One reactivity mechanism: typed change events with explicit flush ordering; single debounced viz adapter at the edge
- [ ] Code names track wp Appendix D glossary (weight / throughput / size)
- [ ] Test seams: core tested directly, integration through the `Scaffold` facade (v1 has ~119 test files importing src internals, making reshuffles expensive)

## Initial build order

2. [ ] Store + ingestion funnel + event mechanism; commutativity property test
3. [ ] Consensus: conflict detection, per-conflict fork choice, canonicality with penalties (recompute-on-dirty v0 behind a narrow interface)
4. [ ] Roles: author, aggregation building + merkle mask (wp §4.6), sampling/probing, insurance/collateral
5. [ ] Economics simulation harness; validate against wp App. E equilibrium numbers

## Known gaps / deferrals

- [ ] Block codec is tagged JSON (`taggedStringify`/`taggedParse`), which is value-stable but not byte-stable: decoding then re-encoding a received block generally yields different bytes, hence a different hash. `raw` is therefore the only source of block identity -- never rebuild wire bytes from a decoded payload. Replace with a canonical binary codec, then assert `encode(decode(raw)) === raw` at ingestion (wp 4.1)
- [ ] Ingestion error handling at the funnel edge: `BlockIngestor.deserialize` throws on malformed input and nothing catches it, so no warn is logged for bad peer data (AGENTS.md). Also `AtomStore.ingest` marks the hash `ingestingAtom` before deserializing, so a throw leaves the entry poisoned forever -- later `get(hash)` throws "Cannot get an ingesting fact!" rather than reporting a known-bad atom
- [ ] Canonicality recompute is O(N) in v0; incremental O(log N) later (the interface must allow the swap)
- [ ] Delete `src/core/CoreContext.ts` (dead stub) when cutting over old code
- [ ] docs/v2/scaffold.md is still empty; fill once the facade API firms up
- [ ] `PlacementService.getCanonicalAggregator` picks the sole aggregator and `todo()`s when a block has more than one. Competing aggregations are a fork (wp §6.4) and choosing between them is fork choice; anchor selection is blocked on consensus for any contested block
- [ ] Nothing retries a stalled build. `BlockBuilderModule.build` parks the draft in `currentBuild: 'pending_aggregation'` and returns the tips, but subscribing to those tips' `listeners` and re-running the build is reactive-layer work that doesn't exist yet
- [ ] Anchor selection needs the full anchor chain in memory: a candidate whose chain hits a `BlockRef` is dropped, because an unresolved link can hide an exclude. That conflicts with wp §3.3's "most blocks are expected to be forgotten" -- a light client that forgot its anchor chain can't place at all. Either placement fetches on demand, or reach has to be provable from an O(log N) path
- [ ] Placement prefers the tightest covering anchor (the freshest block that still reaches everything). That assumes the loose reading of wp §4.2's "larger tree" constraint; under a strict reading a fresh leaf could never anchor at another fresh leaf, and the preference would have to invert. Ties into the "size" decision above
