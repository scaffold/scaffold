# If Finishing Scaffold: Protocol and Build Plan

This is a pragmatic completion plan optimized for clarity and delivery.

## Phase 1: Freeze a v1 protocol profile

Define one authoritative profile:

- block shape: `parent/squashes/squashedUtxoIdxs/treeWeights/...`
- required ingest invariants (strict reject list),
- canonicality predicate and tie-breaks,
- verification and collateral completion requirements.

Deliverable: `PROTOCOL_V1.md` with MUST/SHOULD language and fixture examples.

## Phase 2: Make structural validity strict

Move currently implicit/partial checks into hard gates:

- squashability/volume consistency,
- deterministic UTXO index round-trip checks,
- zero-sum or explicitly allowed deviation policy,
- orphan handling policy (temporary accept vs quarantine).

Deliverable: ingest path rejects malformed structures deterministically.

## Phase 3: Complete driver APIs and contract loop

Implement missing driver methods used by advanced contracts:

- hint read/emit flow,
- input collection/ordering semantics,
- compareBlockOrder semantics tied to agreed frontier ordering.

Deliverable: built-in contracts all verifiable via same unified path.

## Phase 4: Fuse canonicality with economic validity

Make spendability depend on:

- structural winner status,
- verifier completion status,
- collateral resolution status.

Deliverable: no economically invalid block can expose spendable outputs.

## Phase 5: Lock complexity targets

For aggregation/index operations:

- binary rank queries for spent arrays,
- linear-time sorted merges,
- committed auxiliary metadata for fast remote verification.

Deliverable: measured and documented path-local complexity under load.

## Phase 6: Build the proving test matrix

Test types:

- property tests for `getUtxoIdx <-> getOutput` round-trip,
- adversarial mergeability/double-spend fuzzing,
- collateral payout conservation and monotonicity tests,
- deterministic replay tests across ingest order permutations.

Deliverable: reproducible conformance suite with seed-based fuzz harness.

## Phase 7: Ship a minimal powerful release

Scope v1 to:

- a small set of canonical contracts (account/root/time/true + one challengeable contract),
- one stable aggregation model,
- one stable collateral policy.

Everything else is experimental behind feature gates.

## Simplification principles for the finish

- One frontier model, not three.
- One canonical score function, versioned.
- One validation surface per feature (avoid duplicate partial paths).
- Prefer explicit rejection over soft TODO behavior.

This yields an elegant, understandable core and makes further sophistication safe.
