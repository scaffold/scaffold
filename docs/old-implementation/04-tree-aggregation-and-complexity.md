# Tree Aggregation and Complexity

This section focuses on the mechanism you highlighted: tree-based coin input/output aggregation.

## 1. Core problem

Given a block graph with parent/squash links, map between:

- a concrete origin output `(block, outputIdx)`,
- and its rebased `utxoIdx` inside an aggregate block’s UTXO space.

If this mapping requires scanning all prior blocks, cost is `O(N)`.
Scaffold’s structure tries to make it path-local.

## 2. Current structure

Each block contains:

- `parent` (frontier vote),
- `squashes[]` (merged subtree heads),
- `squashedUtxoIdxs[]` in parent’s post-output/pre-input space,
- per-input `utxoIdx` in the new aggregate space.

`FrontierService.build` synthesizes these fields by rebasing each squashed subtree into the chosen parent space.

## 3. Key algorithms

### `getUtxoIdx(block, outputIdx, at)`

- finds path from `block` to `at`,
- walks path and updates index offsets through each parent/squash boundary,
- subtracts consumed indices, adds new subtree output ranges.

### `getOutput(block, utxoIdx)`

- resolves whether index hits:
  - local outputs,
  - squashed child output ranges (recursive),
  - or parent space (with spent-index compensation).

### `rebase(block, toVote)`

- remaps spent indices from one vote space to another,
- handles left and right moves across parent/child transitions,
- tracks omitted outputs to keep `newUtxoCount` consistent.

## 4. Why this can be `O(log N)` in spirit

Depth control heuristics use volume growth ratios (`~phi`):

- `PARENT_MIN_VOLUME_RATIO`
- `SQUASH_MIN_VOLUME_RATIO`

If these are enforced and honest volume tracks subtree size, ancestry volume grows geometrically, so path depth is logarithmic in represented work/volume.

That is the intended reason nodes can load path slices instead of full history.

## 5. Where current code is still superlinear

Path-local does not automatically mean logarithmic in implementation:

- spent-index counting uses linear search (`countLt`) where binary search is noted as TODO,
- sorted index merges are sometimes done via flatten+sort (`O(m log m)`) rather than linear k-way merge,
- path discovery can still expand broad squasher sets depending on graph shape.

So practical complexity today is closer to:

- `O(path_len * local_list_sizes)` for index mapping,
- with extra `O(m log m)` in some merge points.

## 6. How to make the `O(log N)` claim real

Use one committed index model and optimize around it:

1. Keep all spend arrays sorted and deduplicated by construction.
2. Replace linear count with binary rank queries.
3. Replace flatten+sort merges with streaming k-way merges.
4. Maintain subtree prefix counters (rank/select friendly bitset or Fenwick-like structure).
5. Commit subtree index metadata in block detail so remote peers can verify index transforms without replaying full subtrees.

## 7. Suggested v1 invariant

For any block `B`, for every input `i`:

- `getOutput(B, B.inputs[i].utxoIdx)` must resolve to `(B.inputs[i].blockHash, B.inputs[i].outputIdx)` after path/link completion.

Treat that as a property-test invariant and reject blocks failing it once all dependencies are available.
