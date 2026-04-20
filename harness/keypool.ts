/**
 * Pool of end-user keypairs. Each user has an initial balance; zero-balance
 * users are "new" and own no genesis outputs. The coordinator checks out a
 * user when spawning a session and returns them when the session ends. A
 * given user is in zero or one sessions at any time.
 */

import { secp } from '../src/util/secp.ts';
import { Hash } from '../src/util/Hash.ts';
import { bin2hex } from '../src/util/hex.ts';
import { powerLaw, type Rng } from './rand.ts';
import type { UserKey } from './types.ts';

export interface BalanceConfig {
  /** Fraction of users with balance = 0 (new users). */
  zeroFraction: number;
  powerLaw: {
    alpha: number;
    min: number;
    max: number;
  };
}

export interface KeyPoolConfig {
  count: number;
  balance: BalanceConfig;
  /** Stable seed prefix; user_i derives from `${seedPrefix}:${i}`. */
  seedPrefix: string;
}

export function buildUserPool(cfg: KeyPoolConfig, rand: Rng): UserKey[] {
  const users: UserKey[] = [];
  for (let i = 0; i < cfg.count; i++) {
    const seed = `${cfg.seedPrefix}:${i}`;
    const privateKey = Hash.digest(`scaffold:user:${seed}`).toBytes();
    const publicKey = secp.getPublicKey(privateKey, true);
    const pubkeyHex = bin2hex(publicKey);
    const isZero = rand() < cfg.balance.zeroFraction;
    const balance = isZero ? 0 : Math.round(
      powerLaw(
        rand,
        cfg.balance.powerLaw.alpha,
        cfg.balance.powerLaw.min,
        cfg.balance.powerLaw.max,
      ),
    );
    users.push({ seed, privateKey, publicKey, pubkeyHex, balance });
  }
  return users;
}

/** Manages checkout/return of keypairs to enforce 1-user-per-active-session. */
export class KeyPool {
  private readonly all: UserKey[];
  private readonly available: Set<string>; // seeds
  private readonly bySeed = new Map<string, UserKey>();

  constructor(users: UserKey[]) {
    this.all = users.slice();
    this.available = new Set(users.map((u) => u.seed));
    for (const u of users) this.bySeed.set(u.seed, u);
  }

  /** All users in stable order (index = user index). */
  get users(): readonly UserKey[] {
    return this.all;
  }

  get availableCount(): number {
    return this.available.size;
  }

  /** Check out a random available user, filtered optionally by predicate. */
  checkout(rand: Rng, filter?: (u: UserKey) => boolean): UserKey | null {
    const candidates: UserKey[] = [];
    for (const seed of this.available) {
      const u = this.bySeed.get(seed)!;
      if (!filter || filter(u)) candidates.push(u);
    }
    if (candidates.length === 0) return null;
    const pick = candidates[Math.floor(rand() * candidates.length)];
    this.available.delete(pick.seed);
    return pick;
  }

  /** Return a previously checked-out user. */
  return(user: UserKey): void {
    if (!this.bySeed.has(user.seed)) {
      throw new Error(`unknown user seed: ${user.seed}`);
    }
    this.available.add(user.seed);
  }
}
