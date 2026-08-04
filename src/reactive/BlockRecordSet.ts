import { Hash, HashPrimitive } from '../util/Hash.ts';
import { Block } from '../graph/types.ts';
import { ReactiveRecordSet, ReactiveRecordSetConfig } from './ReactiveRecordSet.ts';

/**
 * Reactive record set specialized for blocks.
 * Stores blocks by hash and dispatches add/update notifications.
 */
export class BlockRecordSet extends ReactiveRecordSet<Block> {
  private blocks = new Map<HashPrimitive, Block>();

  constructor(config?: ReactiveRecordSetConfig) {
    super(config);
  }

  public getAll(): Iterable<Block> {
    return this.blocks.values();
  }

  public get(hash: Hash): Block | undefined {
    return this.blocks.get(hash.toPrimitive());
  }

  /** Called when a new block arrives. Stores it + dispatches add. */
  public add(block: Block): void {
    const key = block.hash.toPrimitive();
    if (this.blocks.has(key)) return;
    this.blocks.set(key, block);
    this.dispatchAdd(block);
  }

  /** Called when a block's dynamic state changes. Dispatches per-block update. */
  public notifyChanged(block: Block): void {
    this.dispatchUpdate(block);
  }
}
