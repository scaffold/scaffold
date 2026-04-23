# Chess Demo

A two-player chess game built on Scaffold. Acts as a concrete test case for the protocol: contract-verified state transitions, stake + payout via throughput balance, signature-gated turns, and self-claimed RECORD outputs used for user input.

## Concept

- A **GAME_STATE UTXO** carries the right-to-move. Each move block **claims** the previous GAME_STATE and **produces** the next one. The pot (sum of both players' stakes) is locked in that UTXO and flows forward through every move until the terminal block distributes it via SIGNATURE outputs to the winner(s).
- `gameStateContract` (hard contract) verifies legality: parses the previous state, runs the move through `applyMove`, checks clock arithmetic, requires the right signature, and requires an output representing the next state (or the correct payout if terminal).
- Joining a game is modeled as the first move: the create-game block publishes an awaiting-join state; the join block claims it and produces an in-progress state with `black` filled in.

## State shape

See [`src/demo/chess/ChessRules.ts`](../../src/demo/chess/ChessRules.ts) (rules module) and [`src/demo/chess/GameStateCodec.ts`](../../src/demo/chess/GameStateCodec.ts) (binary codec).

`GameState`:
- 64-byte board (piece codes 0..12)
- `toMove`, `castling`, `enPassant`, `halfmoveClock`, `fullmove`
- `whiteClockMs`, `blackClockMs`, `lastMoveAt` — 5+8 time control
- `status`: awaiting_join | in_progress | white_won | black_won | draw | timeout_*

`GameStateEnvelope` wraps `GameState` with the two players' public keys (pubkey field is zero while `awaiting_join`).

Verifier params for a GAME_STATE UTXO: `gameId (32 bytes) || turnId (u32 LE)`. `gameId` is stable across the game's lifetime; `turnId` increments each move so each GAME_STATE UTXO has a distinct verifier.

## Block layouts

**Create-game** (white):
- Outputs: `[GAME_STATE/<gameId>/0 (stake), RECORD/"game" (gameId), agg-marker]`
- Self-claims RECORD/"game". Auto-balance funds the stake from white's SIGNATURE UTXOs.

**Join** (black):
- Claims prev `GAME_STATE/<gameId>/0`.
- Outputs: `[RECORD/"join" (blackPubkey), GAME_STATE/<gameId>/1 (2*stake), agg-marker]`
- Self-claims RECORD/"join". Auto-balance funds black's stake contribution.

**Move** (current mover, non-terminal):
- Claims prev `GAME_STATE/<gameId>/N`.
- Outputs: `[RECORD/"move" (encoded move), GAME_STATE/<gameId>/(N+1) (pot), agg-marker]`
- Self-claims RECORD/"move". No auto-balance needed (pot in = pot out).

**Move** (current mover, terminal — checkmate/stalemate):
- Claims prev `GAME_STATE/<gameId>/N`.
- Outputs: `[RECORD/"move", SIGNATURE/<winner> (pot), agg-marker]`. Or two SIGNATURE outputs for a draw.
- No GAME_STATE output. Pot flows to the winner.

**Timeout claim** (opponent, terminal):
- Identical shape to terminal move, but signed by the **opponent** (the mover out of time). The contract permits `TIMEOUT_MOVE` when the timestamp difference exceeds the mover's remaining clock.

## Contract output namespaces

`gameStateContract.outputNamespaces = [GAME_STATE_CONTRACT, RECORD_CONTRACT]`.

SIGNATURE_CONTRACT is deliberately **not** declared. Payouts use `env.requireOutput({contract: SIGNATURE, params: winner}, pot)` but the partition check doesn't enforce that all SIGNATURE outputs are contract-emitted — throughput balance makes additional SIGNATURE outputs economically untenable (they'd need their own funding). Leaving SIGNATURE unowned lets auto-balance add change outputs freely on the create and join blocks.

## How getOutput + user input will work (future)

The current `ChessGame` wrapper constructs move blocks directly via `scaffold.put()`. The intended long-term flow uses the generation path instead:

1. Frontend calls `scaffold.fetch({contract: GAME_STATE, params: <gameId||nextTurnId>})` → publishes an incentive block.
2. Peer's DraftStrategy sees the canonical incentive, kicks off generation of `gameStateContract`.
3. The contract calls `await env.getOutput({contract: RECORD, params: "move"})`.
4. The peer's `registerOutputHandler(GAME_STATE_CONTRACT, handler)` is invoked; the handler returns a Promise that resolves when the user picks a move on the board.
5. Generation completes, block is signed, gossiped back to the original fetcher.

Blocked on the "application-driven put racing with reactive strategies" issue documented in [TODO.md](../../TODO.md#application-driven-put-racing-with-reactive-strategies).

## Testing

- [`tests/ChessRules.test.ts`](../../tests/ChessRules.test.ts) -- pure rules (17 tests, no Scaffold): openings, castling, en passant, promotion, check/checkmate/stalemate, clock arithmetic.
- [`tests/GameStateCodec.test.ts`](../../tests/GameStateCodec.test.ts) -- binary encoding round-trips (8 tests).
- [`tests/GameStateContract.test.ts`](../../tests/GameStateContract.test.ts) -- contract behavior via `VerifyingEnv` (10 tests): join, legal/illegal moves, checkmate payout, draw, clock timeout.
- [`tests/ChessGame.test.ts`](../../tests/ChessGame.test.ts) -- Scaffold integration (6 tests): single-node create, 2-node create+join, single legal move propagation, illegal-move local rejection, timeout rules smoke.
- [`tests/ChessIndex.test.ts`](../../tests/ChessIndex.test.ts) -- BalanceIndex + ChessIndex reactive updates (4 tests).

Full multi-move 2-node games aren't reliably testable today -- see TODO.

## Running the demo

```
cd demo && npm install && npm run dev
```

Then visit `http://localhost:5173/#chess` (or click "Chess Demo" from the explorer toolbar). Each browser tab is an independent Scaffold node with a self-funded 10 000-unit genesis. To play a game between two tabs, they'd need P2P connectivity -- which this demo does not wire up in-browser yet. The UI is fully functional against any single node: create, inspect, make moves, claim timeouts.

## UI layout

- `demo/src/chess/ChessApp.tsx` -- page shell, wires `Scaffold` + `ChessGame` + `ChessIndex` + `BalanceIndex` and passes state to components.
- `demo/src/chess/Board.tsx` -- 8x8 grid with drag-and-drop. Deliberately allows any move (including illegal) -- the contract's verifier is what enforces legality.
- `demo/src/chess/Clock.tsx` -- ticking clock for the side on move.
- `demo/src/chess/Wallet.tsx` -- free + locked balance.
- `demo/src/chess/GameList.tsx` -- "My Games" and "Open Games" panel with create/join actions.
