import { Hash } from '../util/Hash.ts';
import { Block } from '../core/Block.ts';
import { bin2hex } from '../util/hex.ts';

/** Verifier identifying a contract + params */
export interface Verifier {
  contractHash: Hash;
  params: Uint8Array;
}

/** Options for a fetch request */
export interface FetchOptions {
  /** Callback when canonical result changes */
  onResult: (result: FetchResult | null) => void;
  /** Fetch mode */
  mode?: 'fastest' | 'strongest' | 'latest';
}

/** Result of a fetch */
export interface FetchResult {
  /** The canonical result block */
  block: Block;
  /** The output data */
  data: Uint8Array;
}

/** Handle to cancel a fetch subscription */
export interface FetchHandle {
  /** Close the subscription */
  close(): void;
}

/** Internal subscription record */
interface FetchSubscription {
  onResult: (result: FetchResult | null) => void;
  mode: 'fastest' | 'strongest' | 'latest';
}

export class FetchManager {
  private subscriptions: Map<string, FetchSubscription[]>;

  constructor() {
    this.subscriptions = new Map();
  }

  /** Subscribe to results for a verifier */
  fetch(verifier: Verifier, options: FetchOptions): FetchHandle {
    const key = FetchManager.verifierKey(verifier);
    const sub: FetchSubscription = {
      onResult: options.onResult,
      mode: options.mode ?? 'fastest',
    };

    let subs = this.subscriptions.get(key);
    if (!subs) {
      subs = [];
      this.subscriptions.set(key, subs);
    }
    subs.push(sub);

    let closed = false;
    return {
      close: () => {
        if (closed) return;
        closed = true;
        const currentSubs = this.subscriptions.get(key);
        if (currentSubs) {
          const idx = currentSubs.indexOf(sub);
          if (idx !== -1) {
            currentSubs.splice(idx, 1);
          }
          if (currentSubs.length === 0) {
            this.subscriptions.delete(key);
          }
        }
      },
    };
  }

  /** Called by FetchNotifyStrategy when canonicality changes affect a verifier */
  notify(verifierKey: string, result: FetchResult | null): void {
    const subs = this.subscriptions.get(verifierKey);
    if (!subs) return;
    for (const sub of subs) {
      sub.onResult(result);
    }
  }

  /** Check if there are active subscriptions for a verifier */
  hasSubscription(verifierKey: string): boolean {
    const subs = this.subscriptions.get(verifierKey);
    return subs !== undefined && subs.length > 0;
  }

  /** Get all active verifier keys */
  getActiveVerifierKeys(): string[] {
    return [...this.subscriptions.keys()];
  }

  /** Create a verifier key from a Verifier */
  static verifierKey(verifier: Verifier): string {
    return verifier.contractHash.toHex() + ':' + bin2hex(verifier.params);
  }
}
