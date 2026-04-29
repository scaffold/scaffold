import { Block, parseBlockPacket } from '../core/Block.ts';
import { AtomSource } from '../core/Atom.ts';
import { Hash } from '../util/Hash.ts';

/**
 * Storage plugin: persists raw packet bytes keyed by block hash hex.
 * Storing the on-the-wire bytes (rather than a re-serialization of the
 * Block object) keeps signatures intact across restarts so signer can
 * be recovered cryptographically rather than trusted from a payload
 * field.
 */
export interface StoragePlugin {
  loadAll(): Promise<Array<{ hash: string; data: Uint8Array }>>;
  save(hash: string, data: Uint8Array): Promise<void>;
  remove(hash: string): Promise<void>;
}

/** Callback invoked for each block restored from storage. */
type ProcessBlockFn = (block: Block, raw: Uint8Array) => void;

export class StorageManager {
  private readonly storage: StoragePlugin;
  private readonly processBlock: ProcessBlockFn;

  constructor(storage: StoragePlugin, processBlock: ProcessBlockFn) {
    this.storage = storage;
    this.processBlock = processBlock;
  }

  /**
   * Load every persisted packet and replay it. Returns the count of
   * blocks successfully restored. Packets that fail to parse are
   * skipped (the signature must still verify cryptographically -- a
   * tampered byte changes the hash, which would also no longer match
   * the storage key).
   */
  async restore(): Promise<number> {
    const entries = await this.storage.loadAll();
    let restored = 0;
    for (const entry of entries) {
      const block = parseBlockPacket(entry.data, AtomSource.Storage);
      if (!block) continue;
      this.processBlock(block, entry.data);
      restored++;
    }
    return restored;
  }

  /** Persist the raw packet bytes for a block that became canonical. */
  onCanonical(hash: Hash, raw: Uint8Array): Promise<void> {
    return this.storage.save(hash.toHex(), raw);
  }

  /** Remove a block that lost canonicality. */
  onNonCanonical(hash: Hash): Promise<void> {
    return this.storage.remove(hash.toHex());
  }
}
