# Simplification Ideas

## 1. Collapse frontier vocabulary

Use one vocabulary everywhere:

- `parent` = vote target
- `squashes` = merged heads
- `utxoIdx` = rebased spend index

Avoid parallel legacy names (`frontier child`, `frontier output idx`, legacy detail roots) in active
code paths.

## 2. One scoring engine

Keep exactly one canonical score function in production. If experimentation is needed, version score
functions and tag blocks by score-version.

## 3. Separate protocol from policy

Protocol layer:

- deterministic validity,
- deterministic mergeability,
- deterministic index transforms.

Policy layer:

- incentives,
- dynamic thresholds,
- relay weighting.

This separation will make both reasoning and testing much easier.

## 4. Commit to a compact spend proof format

The current structure already supports path-local transforms. Add one compact commitment for each
block’s spend transform and standardize proof verification API.

This unlocks:

- fast light-node syncing,
- easier anti-equivocation checks,
- cleaner complexity bounds.

## 5. Make optimistic mode explicit

Instead of implicit partial checks, define states:

- `PENDING_STRUCTURE`
- `STRUCTURALLY_VALID`
- `ECONOMICALLY_VALID`
- `CANONICAL`

Then gate user-facing APIs by configurable minimum state.

## 6. Unify tests with protocol fixtures

Build fixture packs that include:

- serialized packets,
- expected canonical sets,
- expected spend maps,
- expected collateral outputs.

Use these fixtures in unit, property, and integration layers.

## 7. Versioned protocol document in-tree

Create a protocol file beside source and version it with code releases:

- `scaffold/PROTOCOL_V1.md`
- `scaffold/PROTOCOL_V1_CHANGELOG.md`

That will prevent design drift from reappearing.
