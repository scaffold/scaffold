import { Context } from '../Context.ts';
import { Hash, HashPrimitive } from '../util/Hash.ts';
import { AtomSerializer } from './AtomSerializer.ts';
import { Atom, AtomBase, AtomType } from './types.ts';

export const ingestingAtom: unique symbol = Symbol('AtomStore.ingestingAtom');

export class AtomStore {
  private atoms = new Map<HashPrimitive, Atom | typeof ingestingAtom>();

  constructor(private ctx: Context) {}

  public get(hash: Hash): Atom | undefined {
    const fact = this.atoms.get(hash.toPrimitive());
    if (fact === ingestingAtom) {
      throw new Error(`Cannot get an ingesting fact!`);
    }
    return fact;
  }

  ingest({ source, receivedAt, raw }: Pick<AtomBase, 'source' | 'receivedAt' | 'raw'>): Atom {
    const hash = Hash.digest(raw);
    const existing = this.atoms.get(hash.toPrimitive());
    if (existing === ingestingAtom) {
      throw new Error(`Cannot re-ingest an ingesting or failed atom!`);
    } else if (existing === undefined) {
      this.atoms.set(hash.toPrimitive(), ingestingAtom);
      const atom = this.ctx.get(AtomSerializer).deserialize({ hash, source, receivedAt, raw });
      this.atoms.set(hash.toPrimitive(), atom);
      return atom;
    } else {
      return existing;
    }
  }
}
