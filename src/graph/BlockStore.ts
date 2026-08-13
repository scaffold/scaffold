import { Context } from '../Context.ts';
import { arrCall } from '../util/array.ts';
import { assert } from '../util/functional.ts';
import { Hash, HashPrimitive } from '../util/Hash.ts';
import { AtomSerializer } from './AtomSerializer.ts';
import { Atom, AtomBase, AtomType, Block, BLOCK_REF_TYPE, BlockRef } from './types.ts';

export const ingestingAtom: unique symbol = Symbol('BlockStore.ingestingAtom');

export class BlockStore {
  private atoms = new Map<HashPrimitive, Block | BlockRef | typeof ingestingAtom>();

  private ingestionListeners = new Set<(block: Block) => void>();

  constructor(private ctx: Context) {}

  onIngest(cb: (block: Block) => void, signal: AbortSignal) {
    if (signal.aborted) return;
    this.ingestionListeners.add(cb);
    signal.addEventListener('abort', () => assert(this.ingestionListeners.delete(cb)));
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

  getAll(): Block[] {
    return Array.from(this.atoms.values()).filter((atom): atom is Block =>
      atom !== ingestingAtom && atom.type === AtomType.Block
    );
  }

  ingest(
    { source, receivedAt, raw }: Pick<AtomBase, 'source' | 'receivedAt' | 'raw'>,
    skipIngestion = false,
  ): Block {
    const hash = Hash.digest(raw);
    const existing = this.atoms.get(hash.toPrimitive());
    if (existing === ingestingAtom) {
      throw new Error(`Cannot re-ingest an ingesting or failed atom!`);
    } else if (existing === undefined || existing.type === BLOCK_REF_TYPE) {
      this.atoms.set(hash.toPrimitive(), ingestingAtom);
      let atom: Atom;
      try {
        atom = this.ctx.get(AtomSerializer).deserialize(
          { hash, source, receivedAt, raw },
          existing,
        );
        assert(atom.type === AtomType.Block, `BlockStore cannot hold a ${atom.type} atom!`);
      } catch (err) {
        const ref = existing ?? this.makeRef(hash);
        ref.ingestionError = err instanceof Error ? err.message : String(err);
        this.atoms.set(hash.toPrimitive(), ref);
        throw err;
      }
      this.atoms.set(hash.toPrimitive(), atom);
      if (!skipIngestion) {
        this.ctx.get(AtomSerializer).ingest(atom);
        arrCall(this.ingestionListeners, this.ctx.logger('block_store'), atom);
      }
      return atom;
    } else {
      if (skipIngestion) {
        throw new Error(`Trying to skip ingestion, but atom ${hash} is already ingested!`);
      }
      return existing;
    }
  }

  // TODO: Make the ingestion flow more streamlined; this is kinda ugly
  doSkippedIngestion(atom: Block) {
    this.ctx.get(AtomSerializer).ingest(atom);
    arrCall(this.ingestionListeners, this.ctx.logger('block_store'), atom);
  }

  private makeRef(hash: Hash): BlockRef {
    return {
      hash,
      type: BLOCK_REF_TYPE,
      connections: [],
      anchoringNodes: [],
      aggregatingNodes: [],
      resolvingOutputs: new Map(),
      listeners: new Set(),
    };
  }
}
