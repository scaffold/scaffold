import { Hash, HashPrimitive } from '../util/Hash.ts';

/**
 * Tracks which blocks have been sent to which peers, used by the gossip
 * layer to avoid re-sending blocks a peer already received from us.
 *
 * The current substrate is one-way: we mark on send, dedup on subsequent
 * pushes. Inbound delivery acks were removed when the `Delivery` packet
 * type was deleted; the future atom-transit-fields refactor reintroduces
 * acknowledgement implicitly (a peer sending us a hash they could only
 * know via us is its own ack).
 */
export class DeliveryTracker {
  private readonly tracking = new Map<HashPrimitive, Set<string>>();

  // ---- Helpers -----------------------------------------------------

  private getOrCreate(hash: Hash): Set<string> {
    const key = hash.toPrimitive();
    let peers = this.tracking.get(key);
    if (!peers) {
      peers = new Set();
      this.tracking.set(key, peers);
    }
    return peers;
  }

  // ---- Public API --------------------------------------------------

  /** Record that a block was sent to a peer. */
  markSent(hash: Hash, peerId: string): void {
    this.getOrCreate(hash).add(peerId);
  }

  /** Check if a block was already sent to a peer. */
  wasSent(hash: Hash, peerId: string): boolean {
    return this.tracking.get(hash.toPrimitive())?.has(peerId) ?? false;
  }

  /** Get peer IDs (from allPeerIds) that have NOT been sent this block. */
  getUnsent(hash: Hash, allPeerIds: string[]): string[] {
    const peers = this.tracking.get(hash.toPrimitive());
    if (!peers) return [...allPeerIds];
    return allPeerIds.filter((id) => !peers.has(id));
  }

  /** Forget all tracking state for a block (e.g. when it is garbage-collected). */
  forget(hash: Hash): void {
    this.tracking.delete(hash.toPrimitive());
  }
}
