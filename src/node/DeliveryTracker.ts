import { Hash, HashPrimitive } from '../util/Hash.ts';

/** Per-peer delivery state for a single block. */
type DeliveryState = 'sent' | 'delivered';

/**
 * Tracks which blocks have been delivered to which peers.
 *
 * Used by the gossip layer to avoid re-sending blocks a peer already
 * has.  Each block is mapped to a set of (peerId -> state) entries
 * where state progresses from 'sent' to 'delivered' once the remote
 * peer acknowledges receipt.
 */
export class DeliveryTracker {
  private readonly tracking = new Map<HashPrimitive, Map<string, DeliveryState>>();

  // ---- Helpers -----------------------------------------------------

  /** Get or create the peer-state map for a given block hash. */
  private getOrCreate(hash: Hash): Map<string, DeliveryState> {
    const key = hash.toPrimitive();
    let peers = this.tracking.get(key);
    if (!peers) {
      peers = new Map();
      this.tracking.set(key, peers);
    }
    return peers;
  }

  // ---- Public API --------------------------------------------------

  /** Record that a block was sent to a peer. */
  markSent(hash: Hash, peerId: string): void {
    const peers = this.getOrCreate(hash);
    // Only set to 'sent' if we have not already recorded a state.
    // Once delivered, we do not regress to sent.
    if (!peers.has(peerId)) {
      peers.set(peerId, 'sent');
    }
  }

  /** Record delivery confirmation from a peer. */
  markDelivered(hash: Hash, peerId: string): void {
    const peers = this.getOrCreate(hash);
    peers.set(peerId, 'delivered');
  }

  /** Check if a block was already sent to a peer (sent or delivered). */
  wasSent(hash: Hash, peerId: string): boolean {
    const key = hash.toPrimitive();
    const peers = this.tracking.get(key);
    if (!peers) return false;
    return peers.has(peerId);
  }

  /** Check if delivery was confirmed by the peer. */
  wasDelivered(hash: Hash, peerId: string): boolean {
    const key = hash.toPrimitive();
    const peers = this.tracking.get(key);
    if (!peers) return false;
    return peers.get(peerId) === 'delivered';
  }

  /** Get peer IDs (from allPeerIds) that have NOT been sent this block. */
  getUnsent(hash: Hash, allPeerIds: string[]): string[] {
    const key = hash.toPrimitive();
    const peers = this.tracking.get(key);
    if (!peers) return [...allPeerIds];
    return allPeerIds.filter((id) => !peers.has(id));
  }

  /** Forget all tracking state for a block (e.g. when it is garbage-collected). */
  forget(hash: Hash): void {
    this.tracking.delete(hash.toPrimitive());
  }
}
