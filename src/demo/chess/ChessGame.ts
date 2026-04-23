// ChessGame: high-level wrapper around Scaffold for the chess demo.
//
// Builds blocks directly via `scaffold.put()`. The contract still runs during
// verification (which is what keeps the game honest). Fetch-based turn
// incentives are orthogonal and can be layered on later.

import type { Scaffold } from '../../Scaffold.ts';
import { GAME_STATE_CONTRACT, RECORD_CONTRACT, SIGNATURE_CONTRACT } from '../../core/Block.ts';
import type { ClaimEntry, Output } from '../../core/BlockCreationModule.ts';
import { makeStoreOutputSpace } from '../../node/NodeContext.ts';
import { gameStateContract } from '../../contracts/GameStateContract.ts';
import { makeAggregationOutput } from '../../contracts/AggregationContract.ts';
import { makeRecordOutput } from '../../contracts/RecordContract.ts';
import { Hash } from '../../util/Hash.ts';
import { secp } from '../../util/secp.ts';
import {
  applyMove,
  CASTLE_BK,
  CASTLE_BQ,
  CASTLE_WK,
  CASTLE_WQ,
  EP_NONE,
  initialBoard,
  type Move,
  STATUS_AWAITING_JOIN,
  STATUS_BLACK_WON,
  STATUS_DRAW,
  STATUS_IN_PROGRESS,
  STATUS_TIMEOUT_BLACK,
  STATUS_TIMEOUT_WHITE,
  STATUS_WHITE_WON,
  TIMEOUT_MOVE,
  WHITE,
} from './ChessRules.ts';
import {
  decodeGameParams,
  decodeGameState,
  encodeGameParams,
  encodeGameState,
  encodeMove,
  GAME_ID_BYTES,
  type GameStateEnvelope,
  makeGameId,
  ZERO_PUBKEY,
} from './GameStateCodec.ts';

const INITIAL_CLOCK_MS = 5 * 60 * 1000;
const ALL_CASTLING = CASTLE_WK | CASTLE_WQ | CASTLE_BK | CASTLE_BQ;

export interface ActiveGame {
  gameId: Uint8Array;
  turnId: number;
  /** The block holding the current GAME_STATE UTXO. */
  blockHash: Hash;
  /** Output index of the GAME_STATE UTXO on `blockHash`. */
  outputIndex: number;
  /** Economic value locked in the GAME_STATE UTXO (the pot while in-progress). */
  value: number;
  /** Decoded game state. */
  state: GameStateEnvelope;
}

function cloneBytes(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  out.set(b);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isTerminal(status: number): boolean {
  return status !== STATUS_AWAITING_JOIN && status !== STATUS_IN_PROGRESS;
}

export class ChessGame {
  private readonly scaffold: Scaffold;
  private contractRegistered = false;

  constructor(scaffold: Scaffold) {
    this.scaffold = scaffold;
    this.ensureContract();
  }

  private ensureContract(): void {
    if (this.contractRegistered) return;
    this.scaffold.registerContract(GAME_STATE_CONTRACT, gameStateContract);
    this.contractRegistered = true;
  }

  get publicKey(): Uint8Array {
    return this.scaffold.publicKey;
  }

  // -- Create a new game -------------------------------------------

  /**
   * Publish a create-game block and return the gameId. Produces:
   *   - GAME_STATE/<gameId>/0 at the initial awaiting-join state, value `stake`
   *   - RECORD/"game" carrying gameId (self-claimed)
   * Auto-balance funds the stake from the creator's signature UTXOs.
   */
  createGame(stake: number, nonce?: Uint8Array): Uint8Array {
    const n = nonce ?? secp.utils.randomPrivateKey();
    const pad = new Uint8Array(GAME_ID_BYTES);
    pad.set(n.slice(0, Math.min(n.length, GAME_ID_BYTES)));
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

    // Include the aggregation marker explicitly so our claim indices (and
    // autoBalance's sig-utxo claim indices) line up with the final layout.
    const outputs = [stateOutput, gameRecord, makeAggregationOutput()];
    const claims: ClaimEntry[] = [
      { index: 1, value: 0 }, // self-claim the RECORD at own idx 1
    ];

    const { block } = this.scaffold.put({ outputs, claims, declaredWeight: 1 });
    if (!block) throw new Error('createGame: put failed');
    return gameId;
  }

  // -- Join a game --------------------------------------------------

  joinGame(gameId: Uint8Array): Hash {
    const active = this.findActiveState(gameId);
    if (!active) throw new Error('joinGame: game not found');
    if (active.state.state.status !== STATUS_AWAITING_JOIN) {
      throw new Error('joinGame: game is not awaiting a join');
    }

    const now = Date.now();
    const joined: GameStateEnvelope = {
      state: {
        board: initialBoard(),
        toMove: WHITE,
        castling: ALL_CASTLING,
        enPassant: EP_NONE,
        halfmoveClock: 0,
        fullmove: 1,
        whiteClockMs: INITIAL_CLOCK_MS,
        blackClockMs: INITIAL_CLOCK_MS,
        lastMoveAt: now,
        status: STATUS_IN_PROGRESS,
      },
      white: active.state.white,
      black: this.publicKey,
    };

    const joinRecord = makeRecordOutput('join', this.publicKey);
    const nextState: Output = {
      verifier: {
        contract: GAME_STATE_CONTRACT,
        params: encodeGameParams(gameId, active.turnId + 1),
      },
      value: active.value * 2,
      data: encodeGameState(joined),
    };

    // Own outputs: [RECORD/join at 0, GAME_STATE at 1]. Self-claim RECORD(0).
    return this.publishClaimBlock(active, [joinRecord, nextState], 0);
  }

  // -- Make a move --------------------------------------------------

  /**
   * Play a move. Only the player on move may call this (contract rejects
   * otherwise). The block claims the prev GAME_STATE UTXO and emits either
   * the next GAME_STATE (non-terminal) or payout SIGNATURE outputs
   * (terminal). The RECORD/"move" output is self-claimed.
   */
  makeMove(gameId: Uint8Array, move: Move): Hash {
    const active = this.findActiveState(gameId);
    if (!active) throw new Error('makeMove: game not found');
    if (active.state.state.status !== STATUS_IN_PROGRESS) {
      throw new Error('makeMove: game not in progress');
    }

    const now = Date.now();
    const nextRules = applyMove(active.state.state, move, now);
    const nextEnv: GameStateEnvelope = {
      state: nextRules,
      white: active.state.white,
      black: active.state.black,
    };

    const moveRecord = makeRecordOutput('move', encodeMove(move));
    const ownOutputs: Output[] = [moveRecord];

    if (!isTerminal(nextRules.status)) {
      ownOutputs.push({
        verifier: {
          contract: GAME_STATE_CONTRACT,
          params: encodeGameParams(gameId, active.turnId + 1),
        },
        value: active.value,
        data: encodeGameState(nextEnv),
      });
    } else {
      const pot = active.value;
      const white = active.state.white;
      const black = active.state.black;
      switch (nextRules.status) {
        case STATUS_WHITE_WON:
        case STATUS_TIMEOUT_BLACK:
          ownOutputs.push(sigOutput(white, pot));
          break;
        case STATUS_BLACK_WON:
        case STATUS_TIMEOUT_WHITE:
          ownOutputs.push(sigOutput(black, pot));
          break;
        case STATUS_DRAW: {
          const half = Math.floor(pot / 2);
          ownOutputs.push(sigOutput(white, half));
          ownOutputs.push(sigOutput(black, pot - half));
          break;
        }
        default:
          throw new Error('unexpected terminal status ' + nextRules.status);
      }
    }

    // Self-claim RECORD at own idx 0.
    return this.publishClaimBlock(active, ownOutputs, 0);
  }

  claimTimeout(gameId: Uint8Array): Hash {
    return this.makeMove(gameId, TIMEOUT_MOVE);
  }

  // -- Queries ------------------------------------------------------

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
        // UtxoIndex tracks canonical unspent outputs. Filter on that directly.
        const entries = ctx.utxoIndex.getByVerifier(o.verifier.contract, o.verifier.params);
        const unspent = entries.some(
          (e) => Hash.equals(e.blockHash, block.hash) && e.outputIndex === i,
        );
        if (!unspent) continue;
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

  /**
   * Subscribe to changes on a specific game. Fires synchronously with the
   * current value, and again on every canonicality flip. Returns unsub.
   */
  observeGame(
    gameId: Uint8Array,
    cb: (state: GameStateEnvelope | undefined) => void,
  ): () => void {
    cb(this.getGameState(gameId));
    const unsub = this.scaffold.context.consensus.onCanonicalityChange(() => {
      cb(this.getGameState(gameId));
    });
    return unsub;
  }

  // -- Internals ----------------------------------------------------

  private findActiveState(gameId: Uint8Array): ActiveGame | undefined {
    let best: ActiveGame | undefined;
    for (const g of this.listActiveGames()) {
      if (!bytesEqual(g.gameId, gameId)) continue;
      if (!best || g.turnId > best.turnId) best = g;
    }
    return best;
  }

  /**
   * Build and publish a block that claims `active`'s GAME_STATE output, has
   * `ownOutputs` as its own outputs, and self-claims `ownSelfClaimIndex`.
   */
  private publishClaimBlock(
    active: ActiveGame,
    ownOutputs: Output[],
    ownSelfClaimIndex: number,
  ): Hash {
    const ctx = this.scaffold.context;
    const outputSpace = makeStoreOutputSpace(ctx.store);

    // Include the aggregation marker ourselves so our claim indices line up
    // with the final block's ownOutputCount. The Scaffold put-path only
    // appends a marker when one isn't already present.
    const outputsWithMarker = [...ownOutputs, makeAggregationOutput()];
    const ownOutputCount = outputsWithMarker.length;

    // Anchor = active.blockHash. New block's extended vector is:
    //   [own outputs + marker] ++ [anchor's post-claim output space]
    // Position of the claimed UTXO in anchor's post-claim space:
    // The claim index on the new block is `ownOutputCount + anchor_extended_index`,
    // where anchor_extended_index is the anchor's extended-vector position of the
    // UTXO we're claiming. Migration walks the extended vector, not the post-claim
    // output space.
    const anchorExtIdx = outputSpace.computeClaimIndex(active.blockHash, {
      block: active.blockHash,
      outputIndex: active.outputIndex,
    });
    if (anchorExtIdx === undefined) {
      throw new Error('publishClaimBlock: could not compute anchor extended index');
    }

    const claims: ClaimEntry[] = [
      { index: ownOutputCount + anchorExtIdx, value: active.value },
      { index: ownSelfClaimIndex, value: 0 },
    ];

    const { block } = this.scaffold.put({
      anchor: active.blockHash,
      outputs: outputsWithMarker,
      claims,
      declaredWeight: 1,
    });
    if (!block) throw new Error('publishClaimBlock: put returned null');
    return block.hash;
  }
}

function sigOutput(pubkey: Uint8Array, value: number): Output {
  return {
    verifier: { contract: SIGNATURE_CONTRACT, params: pubkey },
    value,
    data: new Uint8Array(0),
  };
}

// Re-export for convenience.
export { RECORD_CONTRACT };
