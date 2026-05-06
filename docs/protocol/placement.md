# Placement

Placement is the algorithm that chooses a block's **anchor** at solidification, given the draft's claims and the set of blocks it has been asked to aggregate. The result feeds [block creation](block-creation.md): once the anchor is fixed, [`rebaseOutputIndex`](anchoring.md#algorithm-2-rebaseoutputindex) maps each `ClaimRef` to a concrete index in the anchor's extended output space, and the block can be assembled.

Placement supersedes the LCA-based `resolveAnchor` algorithm previously specified in [anchoring.md](anchoring.md). That document retains only the output-mapping algorithm.

---

## Inputs and Output

| Input | Source | Meaning |
|-------|--------|---------|
| `claimedBlocks` | dedup of `draft.claims[*].producer` | Blocks whose outputs the draft consumes -- the chosen anchor's output space must reach each of them |
| `aggregatedBlocks` | aggregation-contract include constraints | Blocks the draft's `aggregates` field will roll up |
| `excludedBlocks` | caller (typically: prior canonical claimants of the outputs we want) | Blocks that must not appear in the chosen anchor's anchor chain or in any of its canonical aggregator subtrees |

Returns either an `anchor: Hash` or a **stalled** result. Stalled means no anchor exists under the current canonical view; the caller is expected to retry on canonical-view changes.

Aggregates are an **input**, not an output. The draft already knows which blocks it is rolling up by the time placement runs (the aggregation contract accumulated those constraints during generation; see [aggregation.md](aggregation.md#generation-constraints)). Placement's job is anchor selection only.

---

## Definitions

**Anchor chain** of a block `A`:

```
anchorChain(A) = [A, A.anchor, A.anchor.anchor, ..., genesis]
```

The recursive walk along `.anchor` links toward genesis, including `A` itself.

**Canonical aggregator** of a block `X`: the unique canonical block whose `aggregates` field directly contains `X`. Undefined if no canonical block has yet aggregated `X`. Aggregator competition is resolved by [conflict.md](conflict.md): two aggregators that share an aggregate conflict, so at most one canonical aggregator exists for any given block.

**Aggregation chain** of a block `X`:

```
aggregationChain(X) = [X, AggOf(X), AggOf(AggOf(X)), ...]
```

Recursive walk along canonical-aggregator links, starting with `X` itself. Terminates at the first block with no canonical aggregator.

**Sibling aggregation**: two blocks both present in `aggregatedBlocks` for the current placement call.

---

## Pre-processing

Two passes run before the main loop. Both are necessary -- skipping them produces incorrect anchor selection.

### Pass 1: aggregated blocks become claim-like includes

For each block `D` in `aggregatedBlocks`, walk its anchor chain toward genesis until the first block whose **aggregation chain** does not intersect `aggregatedBlocks`. Call that block the **outside anchor** of `D`:

```
outsideAnchor(D) = first B in anchorChain(D)
                   such that aggregationChain(B) ∩ aggregatedBlocks = ∅
```

The aggregation-chain check (rather than just "B not in aggregatedBlocks") is necessary when aggregated blocks span branches. A candidate `B` whose canonical aggregator is in `aggregatedBlocks` would let placement pick a deeper anchor that violates the aggregation [rooted-at-anchor](aggregation.md#invariants) invariant -- the would-be aggregator block would not actually be in `B`'s anchor chain. Walking past such candidates ensures the eventual anchor is on every aggregated block's anchor chain.

The outside anchor is added to the include set as a claim-like input. Sibling aggregations typically share a single outside anchor.

#### Example: single-chain siblings

`aggregatedBlocks = {C, D}` with anchor chain `G <- A <- B <- C <- D`. No canonical aggregators yet.

- `outsideAnchor(C)`: `aggregationChain(C) = [C]` hits at `C`. Walk to `B`. `aggregationChain(B) = [B]` doesn't hit. `→ B`.
- `outsideAnchor(D)`: walks `D -> C -> B`; same as above. `→ B`.
- Include-set contribution: `{B}`.

#### Example: cross-branch aggregation

`aggregatedBlocks = {A1, b5, b6, b7}` where `A1` is the canonical aggregator of `{b1..b4}` (anchored at `G`), and the chain is `G <- b1 <- b2 <- b3 <- b4 <- b5 <- b6 <- b7`.

- `outsideAnchor(A1)`: `aggregationChain(A1) = [A1]` hits at `A1`. Walk to `G`. `aggregationChain(G) = [G]` doesn't hit. `→ G`.
- `outsideAnchor(b5)`: walks `b5 -> b4 -> b3 -> b2 -> b1`. At each, `aggregationChain` includes `A1` (since `A1` aggregates `b1..b4`), which is in `aggregatedBlocks`. Walk all the way to `G`. `aggregationChain(G) = [G]` doesn't hit. `→ G`.
- Same for `b6`, `b7`.
- Include-set contribution: `{G}`. The chosen anchor will be `G`.

If we used the naive rule "first block not in `aggregatedBlocks`", `outsideAnchor(b5)` would return `b4` -- and the main loop would pick `K = b4` because `b4`'s anchor chain reaches both `G` (via the chain) and `b4` itself. But `b4` is not in `A1`'s anchor chain, so a block anchored at `b4` cannot validly aggregate `A1`. The aggregation-chain rule prevents this.

### Pass 2: drop subsumed claims

A claim on block `X` is **subsumed** if `X`'s aggregation chain hits any block in `aggregatedBlocks`:

```
isSubsumed(X) = aggregationChain(X) intersects aggregatedBlocks
```

Subsumed claims are dropped before the main loop. Reasoning: when the draft aggregates the matching block, `X`'s outputs become reachable through that subtree, so `X` does not constrain anchor selection. Worse, leaving `X` in the include set causes the main loop to fail: `X`'s aggregation chain leads into a block we are aggregating ourselves (which is not yet canonical from placement's perspective), so no item in `X`'s chain can satisfy the cross-chain reachability requirement.

---

## Main Loop

The state going into the main loop is a set of **include blocks** -- the union of:

- `claimedBlocks` minus subsumed claims, and
- the outside anchors produced by Pass 1.

Build aggregation chains for every include block and every excluded block:

```
INCLUDES = { aggregationChain(B)  for each include block B }
EXCLUDES = { aggregationChain(E)  for each excluded block E }
```

For each include chain `Ci`, scan items in chain order and select the first `K` such that:

1. `K.anchorChain` intersects every chain in `INCLUDES`, AND
2. `K.anchorChain` intersects no chain in `EXCLUDES`.

If no item satisfies both, `Ci`'s selection is null.

Collect non-null selections into a set `S`:

| `\|S\|` | Result |
|-------|--------|
| 0 | **Stalled** -- return exceptional result |
| 1 | The single element is the anchor |
| > 1 | Internal error -- selections from different include chains disagreed |

The `> 1` case is not expected to occur in well-formed canonical views: each `Ki` is the *first* item in its own chain that achieves cross-chain reachability, and the canonical-aggregator uniqueness invariant should drive selections to converge on a common point. If it ever occurs in practice, surface it as a bug rather than silently picking one.

---

## Worked Examples

### E1: jointly aggregated claims

Claims on `X, Y`. A canonical aggregator `Z` aggregates both.

- `Cx = [X, Z]`, `Cy = [Y, Z]`
- Scan `Cx`: `X.anchorChain = [X, ..., G]` does not reach `Cy`; skip. `Z.anchorChain = [Z, ..., G]` reaches `Cx` at `Z` and `Cy` at `Z`. Select `Z`.
- Scan `Cy`: same logic. Select `Z`.
- `S = {Z}`. Anchor = `Z`.

### E2: disjoint aggregation trees (stall)

Claims on `X, Y`. `X` aggregated by `Zx`, `Y` independently aggregated by `Zy`. No common aggregator yet.

- `Cx = [X, Zx]`, `Cy = [Y, Zy]`
- Scan `Cx`: nothing in `[X, Zx]` has an anchor chain reaching `Cy`. Selection null.
- Scan `Cy`: symmetric. Selection null.
- `S = {}`. Stalled. Caller waits for an aggregation that unifies the trees.

### E3: aggregation pre-processing

`aggregatedBlocks = {C, D}` in chain `G <- A <- B <- C <- D`. No additional claims.

- Pass 1: include set becomes `{B}`.
- `Cb = [B, AggOf(B), ...]`. Main-loop scan picks `B` immediately (its anchor chain intersects `Cb` at `B`).
- Anchor = `B`.

If we had skipped Pass 1 and fed `{C, D}` directly into the main loop, `D.anchorChain` reaches `Cc` at `C`, so the algorithm would select `D` -- wrong, since `B` is the anchor we need.

### E4: subsumed claim

`aggregatedBlocks = {C}`, claim on `X` where `X` was aggregated by `C` (so `C` is in `aggregationChain(X)`).

- Pass 2: `aggregationChain(X)` hits `C` in `aggregatedBlocks`. Drop the claim on `X`.
- Pass 1: `outsideAnchor(C) = C.anchor`.
- Main loop runs with the include set being just the outside anchor.

If we had kept `X` in the include set, its aggregation chain would lead into `C` -- a block we are aggregating ourselves and which is therefore not a canonical anchor candidate -- and the main loop would fail to find a selection.

### E5: exclude constraint

Claim on `X`. Block `Y` has previously claimed `X`'s outputs and is canonical, so we add `Y` to `excludedBlocks`.

- `Cx = [X, AggOf(X), ...]`, `Cy = [Y, AggOf(Y), ...]`.
- Scan `Cx`. For each `K`, reject if `K.anchorChain` reaches any block in `Cy`.
- If `Y` is on `X`'s canonical lineage, every `K` in `Cx` will be rejected -> stall (correct: there is no anchor under which `X`'s outputs survive).
- If `Y` lives on a separate branch, the first `K` whose anchor chain bypasses `Y` is selected.

---

## Walk-down to descendants (deferred)

Once the main loop produces an anchor `K`, the caller could in principle replace `K` with a descendant -- a block on `K`'s canonical anchoring-child chain (or on its canonical-aggregator chain) whose anchor chain still satisfies the include/exclude constraints. A deeper anchor sits on a fresher part of the canonical view, and the constructed block locks in more accumulated descendant weight against future reorgs.

This step is **not implemented in v1**. The trade-off has both directions:

- *Pro deeper*: more accumulated weight in the chosen branch; the constructed block is a stronger conflict participant on its lineage.
- *Pro shallower*: lighter / fresher blocks are more reorg-prone, so anchoring deeper increases the chance the draft has to be re-placed when the canonical view shifts.

Pin a heuristic only after we have empirical reorg data. See [Open Questions](#open-questions).

---

## Stall Semantics

A stall means: under the current canonical view, no single block satisfies cross-chain reachability for the include set. The cause is structural -- the include set spans multiple canonical aggregation trees that have not yet been unified.

The caller's contract:

1. Catch the stalled result and pause solidification of the draft.
2. Subscribe to canonical-view changes (block addition, canonicality flip).
3. On any change, retry placement.
4. Stalls clear when an aggregation block (created locally or ingested from a peer) connects the disjoint trees.

Placement does **not** trigger aggregation. A separate strategy may observe stalled drafts and emit aggregation-trigger actions, but that policy lives outside this module.

---

## Module Boundary

### Provider Inputs

| Method | Description |
|--------|-------------|
| `getAnchor(hash)` | Anchor of a block. Used to walk anchor chains. |
| `getAggregates(hash)` | Direct aggregates of a block. Used by Pass 1 to detect siblings. |
| `getCanonicalAggregator(hash)` | The canonical block that aggregates `hash`, or undefined. Used to build aggregation chains. |

The module reads canonicality only via `getCanonicalAggregator`. It does not need `getDescendantWeight` or any conflict-state lookups.

### Outputs

| Output | Consumer | Description |
|--------|----------|-------------|
| `anchor` | [`BlockBuilderModule`](block-creation.md) | Selected anchor for the constructed block |
| Stalled signal | Draft / strategy layer | Indicates the caller should retry on canonical-view changes |

### Invariants

1. **Anchor coverage**: the returned anchor's anchor chain (extended through canonical aggregators) reaches every (non-subsumed) claim and every outside anchor produced by aggregation pre-processing.
2. **Exclude safety**: the returned anchor's anchor chain does not reach any excluded block.
3. **No re-aggregation**: subsumed claims are dropped before main loop -- they are reachable through the draft's own aggregation, not through anchor selection.
4. **Pure**: placement is a function of the block graph and the canonical view at the call site. It mutates no module state.

---

## Open Questions

### Walk-down trade-off

What heuristic, if any, should govern descending below the selected anchor? Options on the table:
- Always use the shallowest (current behavior).
- Walk to the deepest descendant whose effective weight exceeds a threshold.
- Walk to the deepest descendant whose canonicality has been stable for some window.

Deferred until we have empirical reorg data from real workloads.

### Multi-selection invariant proof

The main loop assumes `|S| <= 1`. The argument relies on canonical-aggregator uniqueness and aggregation-chain ordering. A formal proof (or a constructed counterexample) would either close the case or motivate a tie-break rule. Until then, the implementation logs an internal error if the case occurs.

### Exclude derivation

`excludedBlocks` is currently caller-supplied. Two derivation strategies exist for the common case (excluding prior claimants of our outputs):
- Caller computes the exclude set from `output-claims` data and passes it explicitly.
- Placement walks anchor chains itself and prunes any branch whose claim mask hits one of the desired outputs.

The first is the default per this spec; the second is an implementation alternative that avoids materializing the exclude set up-front. They are equivalent in result.

---

## Relation to Other Docs

- [anchoring.md](anchoring.md): retains [`rebaseOutputIndex`](anchoring.md#algorithm-2-rebaseoutputindex) and the four-cases output-mapping algorithm. The `resolveAnchor` section is superseded by this document and will be removed in the implementation pass.
- [draft-blocks.md](draft-blocks.md): describes when placement runs (at solidification) and how drafts participate in consensus before placement resolves.
- [aggregation.md](aggregation.md): defines aggregation include constraints (the source of `aggregatedBlocks`) and the canonical-aggregator uniqueness property the algorithm depends on.
- [output-claims.md](output-claims.md): the source of `claimedBlocks` (`ClaimRef.producer`).
- [conflict.md](conflict.md): enforces aggregator uniqueness, which placement depends on.

---

## Implementation

| File | Description |
|------|-------------|
| [`src/core/PlacementModule.ts`](../../src/core/PlacementModule.ts) | Pure module: pre-processing (outside-anchor walk + subsumed-claim drop), main loop |
| [`src/core/PlacementService.ts`](../../src/core/PlacementService.ts) | Provider wiring against `BlockStore` + `ConsensusService`. Wraps each `place` call in `NodeWeightsService.withIgnoredNodes` so the in-progress draft is excluded from the canonical view placement consults -- breaks the cycle between placement and consensus weight |
| [`src/core/DraftPlacement.ts`](../../src/core/DraftPlacement.ts) | Shared helpers: `dedupeProducers`, `detectAggregatedBlocks` (treats marker claims as aggregation include constraints until the AggregationContract integration plumbs them onto Drafts), `placeDraft`, `draftAnchorViaPlacement`. Used by `BlockBuilderModule`, `ConsensusService`, and `NodeWeightsService` so all three callers compute the same anchor for any given draft |
| [`src/core/ConsensusModule.ts`](../../src/core/ConsensusModule.ts) | `getCanonicalAggregator(hash)` query the placement provider routes through. Re-entrant `ensureCanonical` seeds an empty cache so re-entry returns rather than recursing -- first-pass placement sees no canonical aggregators, subsequent passes see the converged view |
| [`tests/Placement.test.ts`](../../tests/Placement.test.ts) | State-transition tests covering: simple anchor, sibling-aggregation pre-processing, jointly-aggregated claims, disjoint-tree stall, subsumed claims, exclude constraints |

The previous LCA-based `resolveAnchor` algorithm has been removed from `src/core/AnchoringModule.ts`; that module retains only [`rebaseOutputIndex`](anchoring.md#rebaseoutputindex) and the path-finding utilities. The legacy `src/core/AnchorSelection.ts` (which was the actual production fallback before this work landed) has been deleted.
