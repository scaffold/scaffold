// ChessGame: thin wrapper around Scaffold for the chess demo.
//
// Design: generator-driven. The only `put` in chess is `createGame()` --
// it introduces the initial GAME_STATE UTXO. Every subsequent block is
// produced by a generator that DraftStrategy spawns automatically on the
// unclaimed GAME_STATE UTXO:
//   - claimNext() claims the prev state.
//   - requestBody(RECORD/"move" or "join") blocks until our registered
//     handler resolves (see `resolvePrompt`).
//   - sign(mover) filters which node's generator actually
//     produces the block: only the mover's node can sign.
//
// React populates `pending` (via `promptMove` / `promptJoin`); clicking a
// piece or "Join" calls `resolvePrompt(key, bytes)`; the generator wakes
// and produces a block.

import type { Scaffold } from '../../Scaffold.ts';
import { GAME_STATE_CONTRACT, RECORD_CONTRACT } from '../../core/Block.ts';
import type { Output } from '../../core/BlockCreationModule.ts';
import { gameStateContract } from '../../contracts/GameStateContract.ts';
import { makeAggregationOutput } from '../../contracts/AggregationContract.ts';
import { makeRecordOutput } from '../../contracts/RecordContract.ts';
import { Hash } from '../../util/Hash.ts';
import { bin2hex } from '../../util/hex.ts';
import { secp } from '../../util/secp.ts';
import {
  CASTLE_BK,
  CASTLE_BQ,
  CASTLE_WK,
  CASTLE_WQ,
  EP_NONE,
  initialBoard,
  STATUS_AWAITING_JOIN,
  WHITE,
} from './ChessRules.ts';
import {
  decodeGameParams,
  decodeGameState,
  encodeGameParams,
  encodeGameState,
  GAME_ID_BYTES,
  type GameStateEnvelope,
  makeGameId,
  ZERO_PUBKEY,
} from './GameStateCodec.ts';

const INITIAL_CLOCK_MS = 5 * 60 * 1000;
const ALL_CASTLING = CASTLE_WK | CASTLE_WQ | CASTLE_BK | CASTLE_BQ;

const MOVE_KEY = new TextEncoder().encode('move');
const JOIN_KEY = new TextEncoder().encode('join');

/** A live UTXO representing a game state. */
export interface ActiveGame {
  gameId: Uint8Array;
  turnId: number;
  blockHash: Hash;
  outputIndex: number;
  value: number;
  state: GameStateEnvelope;
}

/** One outstanding UI-initiated prompt: "the user should act on this turn". */
export interface PendingPrompt {
  /** Stable key: gameIdHex + ':' + turnId + ':' + kind. */
  readonly key: string;
  readonly gameId: Uint8Array;
  readonly turnId: number;
  /** 'move' or 'join'. */
  readonly kind: 'move' | 'join';
  /** Caller resolves this to unblock the generator. Idempotent. */
  resolve(bytes: Uint8Array): void;
  /** True once resolved; further calls are no-ops. */
  resolved: boolean;
}

/**
 * Internal parking slot used by the output handler. There's one per
 * (gameId, turnId, kind) the handler has been called for. The handler
 * blocks on its Promise; `resolveWaiter` fires it. The UI's
 * `PendingPrompt.resolve` goes through `resolveWaiter` too.
 */
interface Waiter {
  resolved: boolean;
  bytes?: Uint8Array;
  resolvers: ((bytes: Uint8Array) => void)[];
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function kindFor(params: Uint8Array): 'move' | 'join' | null {
  if (bytesEqual(params, MOVE_KEY)) return 'move';
  if (bytesEqual(params, JOIN_KEY)) return 'join';
  return null;
}

function promptKey(gameId: Uint8Array, turnId: number, kind: string): string {
  return bin2hex(gameId) + ':' + turnId + ':' + kind;
}

export class ChessGame {
  private readonly scaffold: Scaffold;
  private contractRegistered = false;
  /** UI-facing store, populated only by promptMove/promptJoin. */
  private readonly pending = new Map<string, PendingPrompt>();
  /** Generator-facing parking slots, populated by the output handler. */
  private readonly waiters = new Map<string, Waiter>();
  private readonly changeListeners: (() => void)[] = [];

  constructor(scaffold: Scaffold) {
    this.scaffold = scaffold;
    this.ensureRegistered();
  }

  private ensureRegistered(): void {
    if (this.contractRegistered) return;
    this.scaffold.registerContract(GAME_STATE_CONTRACT, gameStateContract);
    // Generator-side bridge: when the contract calls
    // env.requestBody(RECORD/"move" or "join") inside GAME_STATE_CONTRACT,
    // the host invokes this handler. We always return a Promise for a
    // recognized (gameId, turnId, kind) tuple; the Promise resolves when
    // someone calls `resolvePrompt` (or the matching prompt's `resolve`).
    // On a node that never gets user input for this tuple (e.g., the
    // non-mover), the Promise blocks indefinitely -- that's correct: that
    // node's generator should never produce this block.
    this.scaffold.registerOutputHandler(
      GAME_STATE_CONTRACT,
      (runningParams, outputVerifier) => {
        if (!Hash.equals(outputVerifier.contract, RECORD_CONTRACT)) {
          return Promise.resolve(null);
        }
        const kind = kindFor(outputVerifier.params);
        if (!kind) return Promise.resolve(null);
        let gameId: Uint8Array;
        let turnId: number;
        try {
          const parsed = decodeGameParams(runningParams);
          gameId = parsed.gameId;
          turnId = parsed.turnId;
        } catch {
          return Promise.resolve(null);
        }
        const key = promptKey(gameId, turnId, kind);
        const waiter = this.ensureWaiter(key);
        if (waiter.resolved && waiter.bytes) {
          const bytes = waiter.bytes;
          this.waiters.delete(key);
          return Promise.resolve({ value: 0, data: bytes });
        }
        return new Promise<{ value: number; data: Uint8Array }>((resolve) => {
          waiter.resolvers.push((bytes) => {
            this.waiters.delete(key);
            resolve({ value: 0, data: bytes });
          });
        });
      },
    );
    this.contractRegistered = true;
  }

  get publicKey(): Uint8Array {
    return this.scaffold.publicKey;
  }

  // -- createGame: the only `put` entry point -----------------------

  /**
   * Publish a create-game block and return the gameId. Emits:
   *   - GAME_STATE/<gameId>/0 with an awaiting-join state (value = stake)
   *   - RECORD/"game" carrying the gameId (self-claimed, informational)
   * Auto-balance funds the stake from the creator's signature UTXOs.
   */
  createGame(stake: number, nonce?: Uint8Array): Uint8Array {
    const raw = nonce ?? secp.utils.randomPrivateKey();
    const pad = new Uint8Array(GAME_ID_BYTES);
    pad.set(raw.slice(0, Math.min(raw.length, GAME_ID_BYTES)));
    const gameId = makeGameId(this.publicKey, pad);

    const awaiting: GameStateEnvelope = {
      state: {
        board: initialBoard(),
        toMove: WHITE,
        castling: ALL_CASTLING,
        enPassant: EP_NONE,
        halfmoveClock: 0,
        fullmove: 1,
        whiteClockMs: INITIAL_CLOCK_MS,
        blackClockMs: INITIAL_CLOCK_MS,
        lastMoveAt: Date.now(),
        status: STATUS_AWAITING_JOIN,
      },
      white: this.publicKey,
      black: ZERO_PUBKEY,
    };

    const stateOutput: Output = {
      verifier: {
        contract: GAME_STATE_CONTRACT,
        params: encodeGameParams(gameId, 0),
      },
      value: stake,
      data: encodeGameState(awaiting),
    };
    const gameRecord = makeRecordOutput('game', gameId);
    // PutManager appends the aggregation marker; the RECORD output is
    // automatically self-claimed by BlockBuilder (any output whose
    // verifier.contract is RECORD_CONTRACT). No explicit claim needed
    // for the record. Auto-balance pulls the creator's sig UTXOs to
    // fund the stake on the GAME_STATE output.
    const outputs = [stateOutput, gameRecord];

    const { block } = this.scaffold.put({ outputs, declaredWeight: 1 });
    if (!block) throw new Error('createGame: put failed');
    return gameId;
  }

  // -- Pending-prompt management -----------------------------------

  /**
   * Tell the wrapper "the user has decided to move in this game"; the
   * returned prompt's resolve() unblocks the generator when called with
   * the encoded move bytes.
   *
   * If a prompt for the same (gameId, turnId, 'move') key already exists,
   * returns the existing one. UI layers can use this to wire a board that
   * accepts a user click at any time: call `promptMove` eagerly on the
   * current turn, then resolve it when the user picks a square.
   */
  promptMove(gameId: Uint8Array, turnId: number): PendingPrompt {
    return this.ensurePrompt(gameId, turnId, 'move');
  }

  /** Same as promptMove, but for the join-block's RECORD/"join" output. */
  promptJoin(gameId: Uint8Array, turnId: number): PendingPrompt {
    return this.ensurePrompt(gameId, turnId, 'join');
  }

  /**
   * Resolve a pending prompt directly by key. Equivalent to calling
   * prompt.resolve(bytes). Idempotent.
   */
  resolvePrompt(key: string, bytes: Uint8Array): void {
    const p = this.pending.get(key);
    if (!p) return;
    p.resolve(bytes);
  }

  /** Drop a prompt without resolving (e.g., user cancels). */
  cancelPrompt(key: string): void {
    if (!this.pending.has(key)) return;
    this.pending.delete(key);
    this.notifyChange();
  }

  /** Snapshot of all outstanding prompts. */
  listPending(): PendingPrompt[] {
    return [...this.pending.values()];
  }

  /** Subscribe to prompt-store changes. Fires on add/resolve/cancel. */
  onPendingChange(cb: () => void): () => void {
    this.changeListeners.push(cb);
    return () => {
      const i = this.changeListeners.indexOf(cb);
      if (i >= 0) this.changeListeners.splice(i, 1);
    };
  }

  private ensurePrompt(
    gameId: Uint8Array,
    turnId: number,
    kind: 'move' | 'join',
  ): PendingPrompt {
    const key = promptKey(gameId, turnId, kind);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const self = this;
    const prompt: PendingPrompt = {
      key,
      gameId: cloneBytes(gameId),
      turnId,
      kind,
      resolved: false,
      resolve(bytes: Uint8Array) {
        if (prompt.resolved) return;
        prompt.resolved = true;
        self.resolveWaiter(key, bytes);
        self.pending.delete(key);
        self.notifyChange();
      },
    };
    this.pending.set(key, prompt);
    this.notifyChange();
    return prompt;
  }

  /**
   * Get-or-create the parking slot for a (gameId, turnId, kind). Callers
   * that don't go through a UI PendingPrompt use this directly: e.g., a
   * test can stuff bytes into a waiter before the handler is called.
   */
  private ensureWaiter(key: string): Waiter {
    let w = this.waiters.get(key);
    if (!w) {
      w = { resolved: false, resolvers: [] };
      this.waiters.set(key, w);
    }
    return w;
  }

  /**
   * Fulfill a parking slot. If the handler has already run, fires the
   * queued resolver; otherwise caches the bytes so the next handler call
   * returns them immediately.
   */
  private resolveWaiter(key: string, bytes: Uint8Array): void {
    const w = this.ensureWaiter(key);
    if (w.resolved) return;
    w.resolved = true;
    w.bytes = bytes;
    const resolvers = w.resolvers.splice(0);
    for (const r of resolvers) r(bytes);
  }

  private notifyChange(): void {
    for (const cb of this.changeListeners) cb();
  }

  // -- Queries -----------------------------------------------------

  getActive(gameId: Uint8Array): ActiveGame | undefined {
    return this.findActiveState(gameId);
  }

  getGameState(gameId: Uint8Array): GameStateEnvelope | undefined {
    return this.findActiveState(gameId)?.state;
  }

  /** Enumerate all canonical active GAME_STATE UTXOs visible locally. */
  listActiveGames(): ActiveGame[] {
    const ctx = this.scaffold.context;
    const out: ActiveGame[] = [];
    for (const block of ctx.store.values()) {
      for (let i = 0; i < block.outputs.length; i++) {
        const o = block.outputs[i];
        if (!Hash.equals(o.verifier.contract, GAME_STATE_CONTRACT)) continue;
        // "Unspent" for chess display means: no real canonical block has
        // claimed this GAME_STATE. Phantom-draft claims (the mover's
        // turn-N+1 draft parked on requestBody) reserve in UtxoIndex but
        // don't actually consume the output until they publish a real
        // block. Going through OutputClaimService lets us filter to
        // real-block claimants only.
        if (!isUnspentByCanonicalBlock(ctx, block.hash, i)) continue;
        if (!o.data) continue;
        let env: GameStateEnvelope;
        try {
          env = decodeGameState(o.data);
        } catch {
          continue;
        }
        const params = decodeGameParams(o.verifier.params);
        out.push({
          gameId: cloneBytes(params.gameId),
          turnId: params.turnId,
          blockHash: block.hash,
          outputIndex: i,
          value: o.value,
          state: env,
        });
      }
    }
    return out;
  }

  /** Subscribe to state changes. Fires on every canonicality flip. */
  observeGame(
    gameId: Uint8Array,
    cb: (state: GameStateEnvelope | undefined) => void,
  ): () => void {
    cb(this.getGameState(gameId));
    return this.scaffold.context.consensus.onCanonicalityChange(() => {
      cb(this.getGameState(gameId));
    });
  }

  private findActiveState(gameId: Uint8Array): ActiveGame | undefined {
    let best: ActiveGame | undefined;
    for (const g of this.listActiveGames()) {
      if (!bytesEqual(g.gameId, gameId)) continue;
      if (!best || g.turnId > best.turnId) best = g;
    }
    return best;
  }
}

function cloneBytes(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  out.set(b);
  return out;
}

/**
 * True if `(blockHash, outputIndex)` has no claim from any real
 * canonical block. Phantom-draft claims (canonical drafts that haven't
 * published) are filtered out -- they're identifiable by the claimant
 * not being in the BlockStore.
 */
export function isUnspentByCanonicalBlock(
  ctx: {
    outputClaims: import('../../core/OutputClaimService.ts').OutputClaimService;
    store: { has(h: Hash): boolean };
    consensus: { isCanonical(h: Hash): boolean };
  },
  blockHash: Hash,
  outputIndex: number,
): boolean {
  const claimants = ctx.outputClaims.getClaimantsAt(blockHash, outputIndex);
  if (!claimants) return true;
  for (const c of claimants) {
    if (ctx.store.has(c.claimant) && ctx.consensus.isCanonical(c.claimant)) {
      return false;
    }
  }
  return true;
}
