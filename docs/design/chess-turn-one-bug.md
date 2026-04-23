# Post-join Turn=1 Move Not Publishing

**Status.** Open. Tracked from `TODO.md#Post-join move-turn generator not starting on the non-signing node`.

**Reproduction.** `tests/ChessGame.test.ts` covers the join flow end-to-end (`black.promptJoin(gameId, 0).resolve(blackPub)` produces a real join block). A follow-up test that drives `white.promptMove(gameId, 1).resolve(encodeMove(...))` does not cause white to publish turn=1. No reliable unit-level reproducer exists yet; the first engineering step is to write one in `tests/ChessGame.test.ts`.

## Actual control flow at solidification

`NodeContext._solidifyDraft` (src/node/NodeContext.ts:586-594):

```ts
const block = this._blockCreator.createBlock(spec, this._privateKey);
this.draftManager.cancelDraft(draft.draftId);
if (block) {
  this.reactiveLayer.processBlock(block, null);   // synchronous re-entry
}
```

That last call re-enters `ReactiveLayer.processBlock` with a **fresh `cycleCreated` Set** (src/node/ReactiveLayer.ts:149-156). The cycle guard at line 183 only suppresses blocks produced via `createBlock` actions within the same cycle — it does not suppress blocks produced via solidification. So strategies fully re-evaluate the just-landed block synchronously, in the same stack frame as the solidify.

## Why `_parkedGetOutput` is not the mechanism

`GenerationService._parkedGetOutput` (src/node/GenerationService.ts:191, 434-450) only holds entries that reached the `_waitForGetOutput` fallback — i.e. when `OutputHandlerRegistry.resolve` returned `null`. `ChessGame` registers its handler at construction (src/demo/chess/ChessGame.ts:130-161); the handler returns a pending Promise, never `null`. `GeneratingEnv.getOutput` awaits that handler before ever reaching `_waitForGetOutput` (src/core/GeneratingEnv.ts:190-211). So:

- `parkedGetOutputCount` stays 0 for chess.
- `_removeParkedGetOutput(draftId)` on cancel is a no-op for chess.
- Cancelling a chess-parked draft does NOT settle its handler Promise. The `Waiter` in `ChessGame.waiters` is held alive by the outstanding Promise indefinitely.

## Collision site

Draft collisions are **within a single node**, not across nodes. Each node's `draftStore` / `UtxoIndex` / `consensus` view is local. What the test sees is:

- White's turn=0 draft (from the awaiting-join UTXO) parks in the chess handler.
- Black's turn=0 draft parks similarly until the UI resolves `promptJoin`.
- When black's draft solidifies the join block and processes it synchronously, DraftStrategy re-evaluates and creates a turn=1 draft on black (which parks forever — black has no move prompt).
- When the join block reaches white via the test's block relay, `_solidifyDraft`'s re-entrant `processBlock` is NOT the trigger on white (that path only fires on the producer). White goes through the normal `processBlock` path, which is async wrt the queue, and DraftStrategy creates a turn=1 draft on white. White's user then resolves the move prompt — but the generator does not complete.

## Pre-existing bugs surfaced during investigation

These are distinct from the root cause but live in the same neighborhood and likely contribute:

1. **Stale `DraftStrategy.inFlight` entries.** `inFlight` (src/node/strategies/DraftStrategy.ts:61) keys on `blockHash:outputIndex`. Cleared via `setOutputReleasedHook` (pre-queue only) and via the ready-transition loop (NodeContext.ts:396-401). Drafts that park in `getOutput` reach neither, so their entries are permanent. At default `maxConcurrent=3`, this caps new drafts after a few parked turns.
2. **Leaked chess handler Promises.** `handle.cancel()` has no path to signal the user-registered `OutputHandler`. The ABI has no `AbortSignal`/reject hook. Cancelled drafts leave the chess Waiter alive forever.
3. **`GenerationService._onRestart` is a no-op** (src/node/GenerationService.ts:401-405). Conflict-driven non-canonicality does not cancel the contract run; it just sits holding an `ExecutionQueueModule` worker slot (default `maxWorkers=4`).

## Strongest hypothesis for the root cause

Synchronous re-entrance during solidification cascades: `_solidifyDraft → processBlock → dispatchActions → createDraft → runContract` all happens in one stack frame. The new contract run competes with the parked turn-0 contract for worker slots (maxWorkers=4) and/or interacts with mid-transition draft state. Not yet confirmed — needs a targeted reproducer.

## Proposed fixes, ranked by blast radius

**Minimal.** Defer the re-entrant `processBlock` to a microtask (NodeContext.ts:593-595):

```ts
if (block) {
  queueMicrotask(() => this.reactiveLayer.processBlock(block, null));
}
```

Mirrors the pattern `UtxoIndex._fireReAdded` already uses (src/node/UtxoIndex.ts:98-103). Breaks synchronous re-entry; the solidify frame unwinds before any strategies evaluate on the new block.

**Cleaner.** Mark the block as self-produced and let `DraftStrategy.evaluate` skip self-produced blocks in the same cycle. Pass a flag through `reactiveLayer.processBlock(block, 'self')` or add `result.selfProduced` to `ReactiveEvent`. Rationale: a node that just solidified its own block can wait one canonicality tick before spawning downstream drafts.

**Full cleanup.** Ship the three pre-existing bugs together: `inFlight.delete` on `cancelDraft`; `AbortSignal` threaded through the `OutputHandler` ABI; `_onRestart` actually cancelling parked runs.

## Recommended first step

Write a failing `Deno.test` in `tests/ChessGame.test.ts` that drives a turn=1 move on white after black's join. Keep it failing until a real fix lands (per AGENTS.md "Never Hack Around Bugs or Gaps"). Then try the microtask-defer fix alone and re-measure before deciding whether the bigger-picture fixes need to ride along.

## Files touched during investigation

- src/node/NodeContext.ts
- src/node/ReactiveLayer.ts
- src/node/strategies/DraftStrategy.ts
- src/node/GenerationService.ts
- src/core/DraftManager.ts
- src/core/BlockDraft.ts
- src/core/GeneratingEnv.ts
- src/demo/chess/ChessGame.ts
- tests/ChessGame.test.ts
