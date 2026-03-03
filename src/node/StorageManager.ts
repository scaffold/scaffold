import { Block } from '../core/Block.ts';
import { Hash } from '../util/Hash.ts';

/** Storage plugin interface */
export interface StoragePlugin {
  /** Load all stored blocks, in depth order */
  loadAll(): Promise<Array<{ hash: string; data: string }>>;
  /** Persist a block */
  save(hash: string, data: string): Promise<void>;
  /** Remove a block */
  remove(hash: string): Promise<void>;
}

/** Serializer interface for blocks */
export interface BlockSerializer {
  serialize(block: Block): string;
  deserialize(data: string): Block;
}

/** Callback to process restored blocks */
type ProcessBlockFn = (block: Block) => void;

export class StorageManager {
  private readonly storage: StoragePlugin;
  private readonly serializer: BlockSerializer;
  private readonly processBlock: ProcessBlockFn;

  constructor(
    storage: StoragePlugin,
    serializer: BlockSerializer,
    processBlock: ProcessBlockFn,
  ) {
    this.storage = storage;
    this.serializer = serializer;
    this.processBlock = processBlock;
  }

  /** Load and process all stored blocks */
  async restore(): Promise<number> {
    const entries = await this.storage.loadAll();
    for (const entry of entries) {
      const block = this.serializer.deserialize(entry.data);
      this.processBlock(block);
    }
    return entries.length;
  }

  /** Persist a block that became canonical */
  async onCanonical(block: Block): Promise<void> {
    const data = this.serializer.serialize(block);
    await this.storage.save(block.hash.toHex(), data);
  }

  /** Remove a block that lost canonicality (optional) */
  async onNonCanonical(hash: Hash): Promise<void> {
    await this.storage.remove(hash.toHex());
  }
}
