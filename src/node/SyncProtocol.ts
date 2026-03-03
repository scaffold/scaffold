import { BlockStore } from '../core/Block.ts';
import { Hash, HashPrimitive } from '../util/Hash.ts';
import { PeerConnection } from './PeerConnection.ts';

/**
 * SyncProtocol handles initial chain synchronization when peers connect.
 *
 * Each peer sends their canonical chain tips and chain depth.  The peer
 * with fewer blocks requests the missing ones.  This is a simple
 * tip-exchange protocol -- it does not implement range-based set
 * reconciliation or bisection; those can be layered on later.
 */
export class SyncProtocol {
  constructor(
    private readonly store: BlockStore,
    private readonly getCanonicalTips: () => Hash[],
    private readonly getCanonicalDepth: () => number,
  ) {}

  /**
   * Start sync with a newly connected peer.
   *
   * Sends our current canonical tips and depth so the remote side
   * can decide whether it needs to request blocks from us.
   */
  initSync(peer: PeerConnection): void {
    const tips = this.getCanonicalTips();
    const depth = this.getCanonicalDepth();
    peer.sendSync(tips, depth);
  }

  /**
   * Handle an incoming sync message from a peer.
   *
   * Compares the remote peer's depth with ours.  If the remote peer
   * has greater depth we likely need blocks from them, so we return
   * the tip hashes we do not already have in our store.
   *
   * @returns hashes we should request from the peer (may be empty).
   */
  handleSync(
    peer: PeerConnection,
    tips: string[],
    depth: number,
  ): Hash[] {
    const ourDepth = this.getCanonicalDepth();

    // If we are at the same depth or ahead, there is nothing to request.
    if (ourDepth >= depth) {
      return [];
    }

    // The remote has more depth -- figure out which of their tips we
    // are missing and request those.
    const needed: Hash[] = [];
    for (const tipHex of tips) {
      const hash = Hash.fromHex(tipHex);
      if (!this.store.has(hash)) {
        needed.push(hash);
      }
    }

    // If there are blocks to fetch, ask the peer for them.
    if (needed.length > 0) {
      peer.requestBlocks(needed);
    }

    return needed;
  }
}
