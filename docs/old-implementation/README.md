# Scaffold Protocol Specification Notes

This directory is a code-derived specification and design notebook for the core library in
`scaffold/src`.

It has three goals:

1. Extract the protocol that is actually implemented today.
2. Separate implemented behavior from incomplete or competing designs.
3. Propose a concrete path to finish the protocol with simpler, stronger guarantees.

These notes are based on the current source tree (services, ingestors, contracts, and tests), not on
external docs.

## Reading order

1. `01-project-anatomy.md`
2. `02-protocol-spec-current.md`
3. `03-consensus-canonicality.md`
4. `04-tree-aggregation-and-complexity.md`
5. `05-incentives-and-game-theory.md`
6. `06-version-drift-and-tradeoffs.md`
7. `07-finish-plan.md`
8. `10-protocol-v1-draft.md`
9. `08-code-index.md`
10. `09-simplification-ideas.md`

## Status summary

- Core shape is clear and compelling: optimistic compute graph + delayed adjudication.
- Tree-based aggregation exists and is central (`parent + squashes + rebased utxoIdx`).
- Several critical surfaces are partially implemented:
  - verifier/generator driver methods are stubbed for advanced contracts,
  - some structural validity checks are present but not fully enforced,
  - old and new frontier models both exist in code/comments/tests.
- The project is close to a very strong v1 if scope is reduced and invariants are made explicit.
