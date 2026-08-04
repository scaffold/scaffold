import { Hash } from '../util/Hash.ts';
import { HashPrimitive } from '../util/Hash.ts';

export interface GarbageCollectorConfig {
  /** Maximum number of blocks to keep in store */
  maxBlocks: number;
  /** How many blocks to evict when limit is reached (batch eviction) */
  evictBatch?: number; // default: 10% of maxBlocks, minimum 1
}

export class GarbageCollector {
  private readonly maxBlocks: number;
  private readonly evictBatch: number;

  /**
   * LRU tracking via Map insertion order.
   * The earliest-inserted entry is the least recently used.
   * On touch(), we delete and re-insert to move the entry to the end.
   */
  private readonly lru: Map<HashPrimitive, Hash> = new Map();

  /** Set of hash primitives that are protected from eviction. */
  private readonly protectedSet: Set<HashPrimitive> = new Set();

  constructor(config: GarbageCollectorConfig) {
    this.maxBlocks = config.maxBlocks;
    this.evictBatch = config.evictBatch ??
      Math.max(1, Math.floor(config.maxBlocks * 0.1));
  }

  /** Record that a block was accessed (updates LRU tracking). */
  touch(hash: Hash): void {
    const key = hash.toPrimitive();
    // Delete and re-insert to move to end (most recently used)
    this.lru.delete(key);
    this.lru.set(key, hash);
  }

  /** Mark a block as protected (genesis, canonical chain, active fetches, etc.). */
  addProtected(hash: Hash): void {
    this.protectedSet.add(hash.toPrimitive());
  }

  /** Remove protection from a block. */
  removeProtected(hash: Hash): void {
    this.protectedSet.delete(hash.toPrimitive());
  }

  /**
   * Check if collection is needed and return hashes to evict.
   * Returns the oldest non-protected blocks up to evictBatch count.
   * Returns empty array when currentBlockCount is within the limit.
   */
  collect(currentBlockCount: number): Hash[] {
    if (currentBlockCount <= this.maxBlocks) {
      return [];
    }

    const toEvict: Hash[] = [];

    for (const [key, hash] of this.lru) {
      if (toEvict.length >= this.evictBatch) {
        break;
      }
      if (!this.protectedSet.has(key)) {
        toEvict.push(hash);
      }
    }

    return toEvict;
  }

  /** Remove a hash from tracking (when block is actually removed). */
  forget(hash: Hash): void {
    const key = hash.toPrimitive();
    this.lru.delete(key);
    this.protectedSet.delete(key);
  }
}
