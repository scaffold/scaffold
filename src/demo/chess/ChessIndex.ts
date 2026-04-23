// ChessIndex: reactive map of gameIdHex -> ActiveGame across the node's
// canonical view. Rebuilds eagerly on every canonicality change and fires
// listeners. Thin wrapper around `ChessGame.listActiveGames()` plus a
// subscription for UI code.

import type { Scaffold } from '../../Scaffold.ts';
import { type ActiveGame, ChessGame } from './ChessGame.ts';
import { bin2hex } from '../../util/hex.ts';

export class ChessIndex {
  private readonly scaffold: Scaffold;
  private readonly chess: ChessGame;
  private readonly listeners: (() => void)[] = [];
  private readonly unsubscribe: () => void;
  private cache: Map<string, ActiveGame> = new Map();

  constructor(scaffold: Scaffold, chess?: ChessGame) {
    this.scaffold = scaffold;
    this.chess = chess ?? new ChessGame(scaffold);
    this.rebuild();
    this.unsubscribe = this.scaffold.context.consensus.onCanonicalityChange(
      () => {
        this.rebuild();
        this.notify();
      },
    );
  }

  close(): void {
    this.unsubscribe();
  }

  private rebuild(): void {
    const next = new Map<string, ActiveGame>();
    for (const game of this.chess.listActiveGames()) {
      const key = bin2hex(game.gameId);
      // Keep the highest turnId per gameId.
      const prev = next.get(key);
      if (!prev || game.turnId > prev.turnId) next.set(key, game);
    }
    this.cache = next;
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  /** Subscribe to changes. Fires on every canonicality flip. */
  onChange(cb: () => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Snapshot of all active games, newest-turn-first per game. */
  list(): ActiveGame[] {
    return [...this.cache.values()];
  }

  /** Look up a specific game by gameId (bytes or hex). */
  get(gameId: Uint8Array | string): ActiveGame | undefined {
    const key = typeof gameId === 'string' ? gameId : bin2hex(gameId);
    return this.cache.get(key);
  }

  /** Subset: games awaiting a black player. */
  openGames(): ActiveGame[] {
    return this.list().filter((g) => g.state.state.status === 0 /* awaiting_join */);
  }

  /** Subset: games we participate in (as white or black). */
  myGames(pubkey?: Uint8Array): ActiveGame[] {
    const pk = pubkey ?? this.scaffold.publicKey;
    return this.list().filter((g) => {
      const env = g.state;
      if (bytesEqual(env.white, pk)) return true;
      if (!env.black.every((b) => b === 0) && bytesEqual(env.black, pk)) return true;
      return false;
    });
  }

  /** Access the underlying ChessGame (useful for wiring UI actions). */
  get game(): ChessGame {
    return this.chess;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
