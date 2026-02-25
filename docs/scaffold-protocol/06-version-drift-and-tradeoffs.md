# Version Drift and Tradeoffs

Scaffold currently contains multiple frontier/aggregation generations.

## 1. Observable variants

### Variant A: Frontier-output centric (legacy direction)

- Dedicated frontier outputs with detailed tree payloads.
- Rich per-output frontier detail (`spent masks`, produced/consumed roots, level semantics).
- More explicit in-wire commitments, heavier block detail.

### Variant B: Parent + squashes header model (current active path)

- Parent/squashes/squashed indices are top-level block fields.
- Rebased UTXO indexing done through `FrontierService`.
- Simpler block structure, but some detail commitments moved out or dropped.

### Variant C: Bitmask helper line (partially explored)

- Spend-mask oriented representation for fast disjointness checks and remapping.
- Promising for rank/select and proof-friendly compression.
- Not fully integrated as canonical model.

## 2. Tradeoff table

- Simplicity:
  - best: Variant B
  - medium: Variant C
  - lowest: Variant A
- Proof friendliness:
  - best: Variant A/C
  - weaker: Variant B without committed auxiliary roots
- Runtime ergonomics:
  - best: Variant B
  - medium: Variant C
  - lowest: Variant A
- Spec clarity today:
  - best: Variant B (because it is what active builder/ingestor paths use)

## 3. Recommended convergence

Adopt Variant B as the canonical base model, then add one proof-friendly auxiliary commitment layer:

- keep `parent + squashes + squashedUtxoIdxs` as primary state transition structure,
- add committed compact spend/index metadata per block (mask root or rank/select digest),
- drop redundant legacy frontier-detail fields from v1 wire format.

This keeps implementation simple while preserving a path to succinct verification and efficient remote syncing.

## 4. Test-suite drift notes

Some tests and comments still reference older frontier-level/output detail semantics.
The spec should explicitly mark those as historical context and avoid mixing them into v1 acceptance rules.
