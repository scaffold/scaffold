# Consensus and Canonicality

## 1. Conflict model

Conflicts are output-claim conflicts, not chain-height conflicts.

- Multiple blocks may claim the same logical output.
- Conflict relations are propagated through aggregation links.
- Squasher relationships suppress false conflicts between ancestor/squash-equivalent claims.

The key primitive is `scatterSpends`, which maps a set of UTXO indices through nested
squashes/parents to concrete originating outputs.

## 2. Mergeability

A candidate merge is valid iff no claimed input intersects with conflict closures of selected refs.

In practice:

1. collect all claims touching candidate input spends,
2. for each reference chain, reject if it intersects current conflict set,
3. union in reference conflict sets and continue.

This is the operational double-spend gate for multi-reference block construction.

## 3. Score metrics used for winners

`BlockMetrics` derives a conflict score from several components:

- `selfWork`: base + free-market input amounts - free-market output amounts
- `conservativeSelfWork`: min selfWork over self and direct conflicts
- `ancestorWeight`: parent recursive work + explicit `treeWeights`
- `descendantWeight`: winning children and best squasher descendants
- `freeMarketOutput`
- `claimWeightBoost`

`conflictScore = conservativeSelfWork + freeMarketOutput + ancestorWeight + descendantWeight + claimWeightBoost`

Tie-break: hash order.

## 4. Canonicality rule

`isCanonical(block)` is currently:

- block is conflict winner,
- and parent is canonical (or missing/zero).

That means canonicality is recursively computed over winner edges, not finality-locked epochs.

## 5. Important practical behavior

- Blocks may be ingested before all parents/inputs are known.
- Conflict/canonical state can change as more facts arrive.
- Output availability is maintained only for canonical and uncanonically-unclaimed outputs.

This fits the stated design goal: fast optimistic usability with later repair.

## 6. Risks in current state

- Missing strict validation in some paths allows malformed but parseable structures to live
  temporarily.
- Verification outcomes are not yet a fully hard gate for canonicality in all cases.
- Multiple historical scoring approaches coexist; one v1 scoring model should be frozen.

## 7. Recommendation

For v1, define canonicality in two layers:

1. Structural canonicality (mergeability/conflict winner/parent consistency).
2. Economic validity (verification and collateral thresholds satisfied).

Then make output availability depend on both, not only layer 1.
