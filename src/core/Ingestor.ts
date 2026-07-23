import { Context } from '../Context.ts';
import { bin2str } from '../util/buffer.ts';
import { todo } from '../util/functional.ts';
import { Atom, AtomBase, AtomType, Block, BlockPayload, isBlockPayload } from './types.ts';

export interface Ingestor<AtomType extends Atom> {
  readonly isSigned: boolean;

  serialize(payload: AtomType['payload'], allocator: (size: number) => Uint8Array): Uint8Array;
  deserialize(base: AtomBase): AtomType;

  ingest(atom: AtomType): void;
}

export class BlockIngestor implements Ingestor<Block> {
  readonly isSigned = true;

  constructor(private ctx: Context) {}

  serialize(payload: BlockPayload, allocator: (size: number) => Uint8Array): Uint8Array {
  }

  deserialize(base: AtomBase): Block {
    // TODO(claude): Make this be able to parse bigints and Uint8Arrays (if too difficult to do with JSON, we can use another serialization protocol; I just thought JSON might be simplest for now.)
    const payload: unknown = JSON.parse(bin2str(base.message));
    if (!isBlockPayload(payload)) {
      throw new Error(`Not a block`);
    }

    return { ...base, type: AtomType.Block, payload, claims: [] };
  }

  ingest(atom: Block): void {
  }
}

/*

anchor: Hash;
chain: { weight: bigint; throughput: bigint }[];
aggregates: { block: Hash; outputCount: bigint }[];
claims: bigint[];
refs: bigint[];
outputs: { contractHash: Hash; params: Uint8Array; data?: Uint8Array; amount: bigint }[];
timestampMs: number;

*/

export class UnknownIngestor implements Ingestor<never> {
  readonly isSigned = false;

  constructor(private ctx: Context) {}

  serialize(payload: unknown, allocator: (size: number) => Uint8Array): Uint8Array {
  }

  deserialize(base: AtomBase) {
    return todo();
  }

  ingest(atom: never): void {
  }
}
