# Conflict Detection

The conflict concern determines whether two blocks are **conflicting** -- meaning they cannot both be included in the canonical view. It provides direct conflict declarations to the consensus module, which uses them for branch selection.

The core conflict condition is **double-spend**: two blocks that both claim (spend) the same output. Conflicts are detected through the [output claims module](output-claims.md): when claim migration resolves two claims to the same producing output `{block, outputIndex}`, those claimants are in a double-spend conflict.

This concern is responsible for:
- Detecting double-spend conflicts when two claims resolve to the same output
- Detecting double-aggregation conflicts via aggregation marker outputs
- Declaring conflicts to the consensus module

This concern is **not** responsible for:
- Deciding which conflicting block wins (that's the [consensus module](consensus.md))
- Migrating claims through the DAG (that's the [output claims module](output-claims.md))
- Constructing blocks or computing claim masks (that's [block creation](block-creation.md))
- Defining what outputs represent semantically (application layer)

---

## Conflict Detection via Claim Migration

Conflict detection is a natural byproduct of the output claims module's claim migration. When a block is loaded with claims, each claim entry migrates through the aggregation hierarchy toward the block that actually produced the claimed output. When migration completes, the claim resolves to a concrete `{block, outputIndex}` pair.

If two different blocks' claims both resolve to the same `{block, outputIndex}`, those blocks are attempting to spend the same output -- a double-spend conflict.

### Example

Block A and block B both anchor to block G. A claims index 3 and B claims index 3 in their respective extended vectors. Both claims migrate and resolve to `{G, 2}` (the third output in G's output list). Since both A and B claim the same producing output, they conflict.

```
G: outputs = [o0, o1, o2, o3, o4]

Block A: anchor=G, claims=[3]  --> resolves to {G, 2}
Block B: anchor=G, claims=[3]  --> resolves to {G, 2}

Both resolve to {G, 2} --> A conflicts with B
```

### Different-Anchor Case

Claim migration handles the different-anchor case naturally. If block A anchors to G and block B anchors to a descendant of G, both claims still migrate toward their producing blocks. If they resolve to the same `{block, outputIndex}`, the conflict is detected -- regardless of where the claimants sit in the DAG.

No explicit rebasing is needed. The output claims module's migration algorithm resolves every claim to its producing block by walking through the aggregation hierarchy one hop at a time (see [output-claims.md](output-claims.md#migration)). Two claims that target the same producing output will always converge to the same `{block, outputIndex}`, making the conflict visible.

---

## Self-Claim Exclusion

A block claiming its own output (index < `outputs.length`) does not create conflicts. Self-claims resolve to `{block: self, outputIndex}` -- a producing output that only the block itself can reference. No other block's claim can resolve to the same `{block, outputIndex}` because that output is internal to the claiming block.

Self-claimed outputs are produced and immediately consumed atomically. They never appear in the block's output space, so no descendant can claim them. Two blocks that each self-claim their own index 0 are not conflicting -- each references its own internal output, not a shared resource.

---

## Aggregation Marker Conflicts

Every non-genesis block carries an **aggregation marker output** -- an output whose verifier uses the well-known `AGGREGATION_CONTRACT` hash (see [aggregation.md](aggregation.md#aggregation-contract-output-cache)). This marker exists so that aggregators can claim it to roll up the block.

Since the aggregation marker is a regular output, it follows the same double-spend rules as any other output: it can be claimed at most once. If two blocks both attempt to aggregate the same block, both will claim that block's aggregation marker. Both claims resolve to the same `{block, outputIndex}` (the marker's position in the producing block's output list). This is a double-spend conflict, detected automatically.

### Why This Matters

Without aggregation markers, two aggregators could independently roll up the same block, creating conflicting views of the DAG. The marker mechanism converts this structural constraint into a regular double-spend problem: the producing block's marker is a unique output, and only one aggregator can claim it.

### Example

Block X has an aggregation marker at output index 0. Aggregator blocks E1 and E2 both try to aggregate X:

```
X: outputs = [marker, ...]

E1: claims marker from X --> resolves to {X, 0}
E2: claims marker from X --> resolves to {X, 0}

Both resolve to {X, 0} --> E1 conflicts with E2
```

This prevents double-aggregation using the same mechanism as any other double-spend.

---

## Interaction with Consensus

When a conflict is detected, the consensus module is notified. The consensus module then applies its branch selection rules (effective weight comparison) to determine which block wins. See [consensus.md](consensus.md#conflicts) for how conflicts are resolved.

Conflict declarations from this concern are one of three conflict sources the consensus module handles:

1. **Direct conflicts**: double-spend conflicts detected here (two claims on the same output).
2. **Aggregation conflicts**: a block conflicts with every block it aggregates (structural, from the `aggregates` field).
3. **Inherited conflicts**: a block inherits all conflicts from blocks it aggregates, recursively.

This concern provides source (1). Sources (2) and (3) are derived by the consensus module from the block structure.

---

## Module Boundary

### This Concern Receives

| Input | Source | Description |
|-------|--------|-------------|
| Resolved claims | Output claims module | `{block, outputIndex}` pairs from completed claim migration |
| Block data | Block store | Block structure for claim and output inspection |

### This Concern Provides

| Output | Consumer | Description |
|--------|----------|-------------|
| Direct conflict declarations | Consensus module | "Block X conflicts with block Y" (double-spend detected) |

### Invariants

1. **Symmetry**: If A conflicts with B, then B conflicts with A. Both blocks' claims resolved to the same output -- the relationship is inherently symmetric.
2. **Monotonicity**: Once a conflict is declared, it is never retracted. A resolved claim is permanent -- the producing output does not change.
3. **Completeness**: With full block data loaded, all double-spend conflicts are detected. Every claim migrates to its producing block, and every collision at a `{block, outputIndex}` produces a conflict declaration.
4. **Self-claims excluded**: A block claiming its own output (index < `outputs.length`) does not create conflicts. Self-claimed outputs are internal and unreachable by other blocks' claims.

---

## Implementation

The conflict detection concern is handled by the output claims module, which detects conflicts as a natural consequence of claim migration.

| File | Description |
|------|-------------|
| [`src/core/OutputClaimModule.ts`](../../src/core/OutputClaimModule.ts) | Claim migration and resolution; conflict detection when two claims resolve to the same output |
| [`src/core/OutputClaimService.ts`](../../src/core/OutputClaimService.ts) | Wired adapter using concrete `Block` type |
