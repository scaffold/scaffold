# Protocol V1 Draft (Proposed)

This is a compact proposed target specification to finish the project.

## 1. Deterministic block validity

A block is structurally valid iff all conditions hold:

1. Packet signature is valid.
2. `parent` is known or explicitly marked unresolved (quarantine mode only).
3. `squashes` are unique and each squashed block is known or unresolved (quarantine mode only).
4. `inputs` and `outputs` have non-negative indices/group ids.
5. `treeWeights` are non-negative and length-bounded.
6. `utxoIdx` mapping round-trip holds for every resolvable input:
   - `getOutput(block, input.utxoIdx)` resolves to the declared `(blockHash, outputIdx)`.
7. Squash/volume growth constraints hold.
8. Monetary policy holds:
   - strict zero-sum, or
   - explicit bounded mint/burn policy declared in protocol constants.

Blocks failing hard rules are rejected. Unresolved dependencies can be held only in quarantine, never canonical.

## 2. Deterministic mergeability

Two references are mergeable iff their spend projections are disjoint after recursive scatter through parent/squash transforms.

Duplicate spends in any transformed space are invalid.

## 3. Canonicality

Define:

- `StructuralWinner(block)` from deterministic conflict score + tie-break.
- `EconomicValidity(block)` from verifier/collateral completion policy.

Then:

- `Canonical(block) = StructuralWinner(block) && EconomicValidity(block) && Canonical(parent)`

for non-root blocks.

## 4. Spendability

An output is spendable iff:

- its block is canonical,
- no canonical claim already consumes it,
- verifier/collateral gates for the producing block are satisfied.

## 5. Verification and collateral

Verification engine must support full contract driver surface used by built-in contracts.

Collateral resolution rules are deterministic and include:

- contest type determination,
- result determination,
- payout mapping,
- burn remainder mapping.

All nodes must reach identical payout outputs from identical posting sets.

## 6. Complexity target

For a graph respecting volume-growth constraints:

- output/index mapping should be `O(log N)` path depth with `O(log k)` local rank operations,
- merge/disjoint checks should be near-linear in touched indices.

The protocol must define auxiliary commitments needed to verify these transforms without full graph replay.

## 7. Conformance suite

A release is v1-conformant only if it passes:

- serialization fixture tests,
- structural validity fixtures,
- mergeability/disjointness property tests,
- collateral payout conservation tests,
- canonical replay determinism across randomized ingest order.
