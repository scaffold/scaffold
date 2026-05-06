// BalanceIndex: per-pubkey free / locked balance tracking for the chess demo.
//
// "Free" = sum of unspent SIGNATURE_CONTRACT UTXOs owned by the pubkey.
// "Locked" = value locked in GAME_STATE_CONTRACT UTXOs where this pubkey is
// either white or black. When a game finishes, the pot flows to a SIGNATURE
// output, automatically moving the value from locked to free.
//
// Reactive: subscribes to ConsensusService.onCanonicalityChange and rebuilds
// eagerly. Callers just read; the numbers are always current.

import type { Scaffold } from '../../Scaffold.ts';
import { GAME_STATE_CONTRACT, SIGNATURE_CONTRACT } from '../../core/Block.ts';
import { Hash } from '../../util/Hash.ts';
import { bin2hex } from '../../util/hex.ts';
import { decodeGameState } from './GameStateCodec.ts';
import { isTerminalStatus } from './ChessRules.ts';
import { isUnspentByCanonicalBlock } from './ChessGame.ts';

function pubkeyHex(pk: Uint8Array): string {
  return bin2hex(pk);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface Balance {
  free: number;
  locked: number;
}

export class BalanceIndex {
  private readonly scaffold: Scaffold;
  private readonly listeners: (() => void)[] = [];
  private readonly unsubscribe: () => void;

  constructor(scaffold: Scaffold) {
    this.scaffold = scaffold;
    this.unsubscribe = this.scaffold.context.consensus.onCanonicalityChange(
      () => this.notify(),
    );
  }

  close(): void {
    this.unsubscribe();
  }

  /** Subscribe to balance changes. Returns unsub. */
  onChange(cb: () => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  /** Return the balance for a given pubkey (compressed 33 bytes). */
  getBalance(pubkey: Uint8Array): Balance {
    const utxoIndex = this.scaffold.context.utxoIndex;
    const free = utxoIndex
      .getByVerifier(SIGNATURE_CONTRACT, pubkey)
      .reduce((sum, u) => sum + u.value, 0);

    // Locked: scan the canonical store for unspent GAME_STATE UTXOs where
    // this pubkey participates. The pot value counts once per game (not per
    // player), but from a per-pubkey view we attribute it to each participant
    // fractionally is overkill -- just attribute the full pot to any
    // participant. Players who finish a game see locked drop by the pot and
    // free rise by their share in the same canonicality flip.
    const ctx = this.scaffold.context;
    const store = ctx.store;
    let locked = 0;
    for (const block of store.values()) {
      for (let i = 0; i < block.outputs.length; i++) {
        const o = block.outputs[i];
        if (!Hash.equals(o.verifier.contract, GAME_STATE_CONTRACT)) continue;
        // See note on `isUnspentByCanonicalBlock` -- we ignore phantom
        // draft claims here so the locked balance keeps reflecting the
        // active game even while the mover's next-turn draft parks on
        // getOutput awaiting user input.
        if (!isUnspentByCanonicalBlock(ctx, block.hash, i)) continue;
        if (!o.data) continue;
        try {
          const env = decodeGameState(o.data);
          if (isTerminalStatus(env.state.status)) continue;
          const blackIsParticipant = !env.black.every((b) => b === 0);
          if (
            bytesEqual(env.white, pubkey) ||
            (blackIsParticipant && bytesEqual(env.black, pubkey))
          ) {
            locked += o.value;
          }
        } catch {
          // Malformed state -- ignore.
        }
      }
    }

    return { free, locked };
  }

  /** Short-hand: my balance (uses scaffold.publicKey). */
  get myBalance(): Balance {
    return this.getBalance(this.scaffold.publicKey);
  }

  /** For debugging: dump all pubkeys that currently have SIGNATURE UTXOs. */
  allKnownPubkeys(): Map<string, Balance> {
    const out = new Map<string, Balance>();
    const utxoIndex = this.scaffold.context.utxoIndex;
    const store = this.scaffold.context.store;
    for (const block of store.values()) {
      for (const o of block.outputs) {
        if (Hash.equals(o.verifier.contract, SIGNATURE_CONTRACT)) {
          const pk = o.verifier.params;
          if (pk.length !== 33) continue;
          const key = pubkeyHex(pk);
          if (out.has(key)) continue;
          const entries = utxoIndex.getByVerifier(SIGNATURE_CONTRACT, pk);
          if (entries.length === 0) continue;
          out.set(key, this.getBalance(pk));
        }
      }
    }
    return out;
  }
}
