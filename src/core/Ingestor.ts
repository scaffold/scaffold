import { Context } from '../Context.ts';
import { bin2str, str2bin } from '../util/buffer.ts';
import { assert, todo } from '../util/functional.ts';
import { taggedParse, taggedStringify } from '../util/json.ts';
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
    const message = str2bin(taggedStringify(payload));

    const buf = allocator(message.byteLength);
    assert(buf.byteLength === message.byteLength, `Allocator returned an undersized buffer!`);
    buf.set(message);

    return buf;
  }

  deserialize(base: AtomBase): Block {
    const payload: unknown = taggedParse(bin2str(base.message));
    if (!isBlockPayload(payload)) {
      throw new Error(`Not a block`);
    }

    return { ...base, type: AtomType.Block, payload, claims: [] };
  }

  ingest(atom: Block): void {
  }
}

export class UnknownIngestor implements Ingestor<never> {
  readonly isSigned = false;

  constructor(private ctx: Context) {}

  serialize(payload: unknown, allocator: (size: number) => Uint8Array): Uint8Array {
    return todo();
  }

  deserialize(base: AtomBase) {
    return todo();
  }

  ingest(atom: never): void {
  }
}
