# Subsystem Restructuring

A design exploration for re-organizing `src/core/` into a small number of
subsystems with explicit, narrow boundaries. **Status: brainstorm. Not a
commitment to refactor.**

## The proposal in one paragraph

Today `src/core/` is a flat directory of ~50 files where module boundaries are
implicit (you have to read `// Protocol spec:` headers and trace imports to
figure out what belongs together). The proposal is to introduce four core
subsystems -- **Executor**, **Forest**, **Canonicality**, **Construction** --
each with an `Adapter` (what the host provides to it), a `Provider` (what it
exposes outward), and a `Factory` (how it's constructed). A fifth subsystem,
**Store**, owns the block/draft graph and assembles the other four. Outside
`src/core/` lives everything that is UX (FetchManager, PutManager),
networking, and litigation.

## Files in this folder

- **[categorization.md](categorization.md)** -- table mapping every file in
  `src/core/` to one of the proposed subsystems (or `Shared` / `Top-level`).
  Includes a "Things to discuss" section with the cross-cutting cases.
- **[interfaces.ts](interfaces.ts)** -- proposed `Adapter` / `Provider` /
  `Factory` shapes for each subsystem, with a wiring sketch at the bottom
  showing how `Store` would assemble them. Type-checks against Deno but does
  not import from `src/core/` -- we want freedom to evolve names.

## Naming inversion to be aware of

Current code uses `XxxProvider` to mean "what's provided **to** module Xxx"
(e.g., `AnchoringProvider.getBlock` is provided to `AnchoringModule`). The
proposal flips this:

| Role | Today | Proposed |
|------|-------|----------|
| What the host gives the subsystem | `XxxProvider` | `XxxAdapter` |
| What the subsystem exposes outward | (no consistent name) | `XxxProvider` |
| Constructor | `new XxxModule(provider)` | `new XxxFactory(adapter)` |

If we adopt this layout, every existing `XxxProvider` interface in `src/core/`
is renamed to `XxxAdapter` in one mechanical pass.

## Open questions (cross-referenced)

These are the load-bearing questions to resolve before the proposal becomes
actionable. Each links to where it's discussed in detail.

1. **Subsystem ownership of straddling files.** `OutputSpace.ts`,
   `BlockCreationModule.ts`, and the `Placement*` triple each serve two or
   more subsystems. The placement triple is the gnarliest -- it has a
   cycle-break between placement and weight propagation that any subsystem
   boundary has to preserve. → categorization.md "Things to discuss" #1-#3.

2. **Where `TrustModule` lives.** Forest, or outside core under a future
   "litigation" subsystem? Depends on whether collateral feeds into effective
   weight. → categorization.md #4.

3. **Verification straddles Executor and Canonicality.** The executor *runs*
   verification; canonicality *consumes* the verdict. Who triggers and who
   owns the result lifecycle? → categorization.md #5, interfaces.ts wiring
   note #3.

4. **Store ownership of the graph.** Does `StoreProvider` own the
   block/draft store, or just orchestrate four children that share access?
   The wiring sketch in interfaces.ts assumes ownership. →
   categorization.md #6, interfaces.ts wiring sketch.

5. **`enqueue` vs `execute` semantics.** Joel's sketch had
   `ExecutorProvider.execute(task) -> Promise<boolean>`; today's queue is
   enqueue-and-eventually-run. Pick one and rename. → interfaces.ts
   `ExecutorProvider`.

6. **Inter-subsystem coupling.** Forest writes weight, which should
   re-trigger Canonicality. Three options: (a) Store mediates via callbacks
   in the adapter, (b) Forest's adapter holds a Canonicality handle,
   (c) introduce an event bus. The interfaces.ts wiring sketch picks (a)
   for clarity, but it's the most chatty. → interfaces.ts wiring note #1.

## What we get if this works

- **Clear ownership boundaries.** Every file in `src/core/` has exactly one
  subsystem. Today: ambiguous (which is fine when the codebase is small,
  fragile as it grows).
- **Substitutable subsystems.** Stub `ForestFactory` for tests that don't
  care about weight. Instrumented `CanonicalityFactory` that records every
  decision. Today's tests have to mock the entire `ConsensusProvider`
  surface piecemeal.
- **A single seam between core and not-core.** The `StoreProvider` interface
  is the entire contract that FetchManager/PutManager/gossip see.

## What it costs

- **Mechanical renaming pass.** Every `XxxProvider` interface in `src/core/`
  becomes `XxxAdapter`.
- **A real wiring layer.** Today's `Coordinator.ts` is ~200 lines of
  hand-rolled glue. The new wiring is more disciplined but also more code,
  because each adapter has to be constructed explicitly.
- **Files that genuinely span subsystems need to be split or have a clear
  owner.** `BlockCreationModule.ts` would split into `BlockTypes.ts` (Shared)
  + a Construction-side validator. `OutputSpace.ts` and `AnchorSelection.ts`
  need a designated home or to live in `Shared`.
- **Risk of premature abstraction.** Four subsystems with three interfaces
  each = 12 named types before any real code moves. If the boundaries
  turn out wrong, this is rework.

## Next steps if we keep going

1. Resolve the six open questions above (probably as a sit-down discussion,
   not async).
2. Decide on the naming inversion (yes/no -- this is one rename, easy to
   defer).
3. Pick ONE subsystem to extract first as a vertical slice, end-to-end,
   with adapter/provider/factory + tests + wiring into the existing
   Coordinator. Forest is probably the cleanest target -- already pretty
   self-contained around `NodeWeightsModule` + `SamplingModule`.
4. Evaluate. If the slice feels worse than the status quo, stop. If better,
   continue.
