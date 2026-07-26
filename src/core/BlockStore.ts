import { Context } from '../Context.ts';
import { assert } from '../util/functional.ts';
import { Hash, HashPrimitive } from '../util/Hash.ts';
import { AtomSerializer } from './AtomSerializer.ts';
import { Atom, AtomBase, AtomType, Block, BLOCK_REF_TYPE, BlockRef } from './types.ts';

export const ingestingAtom: unique symbol = Symbol('BlockStore.ingestingAtom');

export class BlockStore {
  private atoms = new Map<HashPrimitive, Block | BlockRef | typeof ingestingAtom>();

  private ingestionListeners = new Set<(block: Block) => void>();

  constructor(private ctx: Context) {}

  onIngest(cb: (block: Block) => void, signal?: AbortSignal) {
    if (signal?.aborted) return;
    this.ingestionListeners.add(cb);
    signal?.addEventListener('abort', () => assert(this.ingestionListeners.delete(cb)));
  }

  get(hash: Hash): Block | BlockRef {
    let fact = this.atoms.get(hash.toPrimitive());
    if (fact === ingestingAtom) {
      throw new Error(`Cannot get an ingesting fact!`);
    } else if (fact === undefined) {
      fact = this.makeRef(hash);
      this.atoms.set(hash.toPrimitive(), fact);
    }
    return fact;
  }

  ingest({ source, receivedAt, raw }: Pick<AtomBase, 'source' | 'receivedAt' | 'raw'>): Block {
    const hash = Hash.digest(raw);
    const existing = this.atoms.get(hash.toPrimitive());
    if (existing === ingestingAtom) {
      throw new Error(`Cannot re-ingest an ingesting or failed atom!`);
    } else if (existing === undefined || existing.type === BLOCK_REF_TYPE) {
      this.atoms.set(hash.toPrimitive(), ingestingAtom);
      const atom = this.ctx.get(AtomSerializer).deserialize(
        { hash, source, receivedAt, raw },
        existing,
      );
      this.atoms.set(hash.toPrimitive(), atom);
      for (const listener of this.ingestionListeners) {
        listener(atom);
      }
      return atom;
    } else {
      return existing;
    }
  }

  private makeRef(hash: Hash): BlockRef {
    return {
      hash,
      type: BLOCK_REF_TYPE,
      connections: [],
      anchoringNodes: [],
      aggregatingNodes: [],
      claimingNodes: [],
      listeners: new Set(),
    };
  }
}
