import Hash, { HashPrimitive } from './Hash.ts';

// type NonUndefined<T> = T extends undefined ? never : T;

export default class Store2<Atom> {
  private entries: Map<HashPrimitive, Atom> = new Map();

  private preInsertListeners: ((hash: Hash, atom: Atom) => void)[] = [];
  private postInsertListeners: ((hash: Hash, atom: Atom) => void)[] = [];
  private preMutateListeners:
    ((hash: Hash, oldAtom: Atom, newAtom: Atom) => void)[] = [];
  private postMutateListeners:
    ((hash: Hash, oldAtom: Atom, newAtom: Atom) => void)[] = [];
  private preRemoveListeners: ((hash: Hash, atom: Atom) => void)[] = [];
  private postRemoveListeners: ((hash: Hash, atom: Atom) => void)[] = [];

  constructor(src?: Store2<Atom>) {
    if (src) {
      this.entries = src.entries;
      this.preInsertListeners = src.preInsertListeners;
      this.postInsertListeners = src.postInsertListeners;
      this.preMutateListeners = src.preMutateListeners;
      this.postMutateListeners = src.postMutateListeners;
      this.preRemoveListeners = src.preRemoveListeners;
      this.postRemoveListeners = src.postRemoveListeners;
    }
  }

  public insert(hash: Hash, atom: Atom) {
    const key = hash.toPrimitive();
    if (this.entries.has(key)) {
      throw new Error(`Store already has key ${hash.toHex()}`);
    }

    this.preInsertListeners.forEach((fn) => fn(hash, atom));
    this.entries.set(key, atom);
    this.postInsertListeners.forEach((fn) => fn(hash, atom));
  }

  public mutate(
    hash: Hash,
    mutator: (prevAtom: Atom) => Atom | undefined,
    initialValue: Atom,
  ) {
    const key = hash.toPrimitive();
    const oldAtom = this.entries.get(key) || initialValue;
    const newAtom = mutator(oldAtom);
    if (newAtom !== undefined) {
      this.preMutateListeners.forEach((fn) => fn(hash, oldAtom, newAtom));
      this.entries.set(key, newAtom);
      this.postMutateListeners.forEach((fn) => fn(hash, oldAtom, newAtom));
    } else {
      this.preRemoveListeners.forEach((fn) => fn(hash, oldAtom));
      this.entries.delete(key);
      this.postRemoveListeners.forEach((fn) => fn(hash, oldAtom));
    }
  }

  public remove(hash: Hash) {
    const key = hash.toPrimitive();
    const atom = this.entries.get(key);
    if (atom === undefined) {
      throw new Error(`Store doesn't contain atom with key ${hash.toHex()}`);
    }

    this.preRemoveListeners.forEach((fn) => fn(hash, atom));
    this.entries.delete(key);
    this.postRemoveListeners.forEach((fn) => fn(hash, atom));
  }

  public set(hash: Hash, newAtom?: Atom) {
    const key = hash.toPrimitive();
    const oldAtom = this.entries.get(key);
    if (oldAtom !== newAtom) {
      if (oldAtom !== undefined) {
        if (newAtom !== undefined) {
          this.preMutateListeners.forEach((fn) => fn(hash, oldAtom, newAtom));
          this.entries.set(key, newAtom);
          this.postMutateListeners.forEach((fn) => fn(hash, oldAtom, newAtom));
        } else {
          this.preRemoveListeners.forEach((fn) => fn(hash, oldAtom));
          this.entries.delete(key);
          this.postRemoveListeners.forEach((fn) => fn(hash, oldAtom));
        }
      } else {
        if (newAtom !== undefined) {
          this.preInsertListeners.forEach((fn) => fn(hash, newAtom));
          this.entries.set(key, newAtom);
          this.postInsertListeners.forEach((fn) => fn(hash, newAtom));
        } else {
          throw new Error(`Shouldn't happen`);
        }
      }
    }
  }

  public map<ReturnAtom>(mapFn: (atom: Atom) => ReturnAtom | undefined) {
    const res = new Store2<ReturnAtom>();
    this.entries.forEach((atom, key) =>
      res.set(Hash.fromPrimitive(key), mapFn(atom))
    );
    this.postInsertListeners.push((hash, atom) => res.set(hash, mapFn(atom)));
    this.postMutateListeners.push((hash, _oldAtom, newAtom) =>
      res.set(hash, mapFn(newAtom))
    );
    this.postRemoveListeners.push((hash, atom) => res.set(hash, mapFn(atom)));
    return res;
  }

  public groupBy<ReturnAtom>(
    keyFn: (atom: Atom) => Hash,
    accumulator: (
      aggregation: ReturnAtom,
      atom: Atom,
    ) => ReturnAtom | undefined,
    decumulator: (
      aggregation: ReturnAtom,
      atom: Atom,
    ) => ReturnAtom | undefined,
    initialValue: ReturnAtom,
  ) {
    const res = new Store2<ReturnAtom>();
    this.entries.forEach((atom, _key) =>
      res.mutate(
        keyFn(atom),
        (prevAtom) => accumulator(prevAtom, atom),
        initialValue,
      )
    );
    this.postInsertListeners.push((_hash, atom) =>
      res.mutate(
        keyFn(atom),
        (prevAtom) => accumulator(prevAtom, atom),
        initialValue,
      )
    );
    this.postMutateListeners.push((_hash, oldAtom, newAtom) => {
      const oldKey = keyFn(oldAtom);
      const newKey = keyFn(newAtom);
      if (oldKey === newKey) {
        res.mutate(
          oldKey,
          (prevAtom) => {
            const mid = decumulator(prevAtom, oldAtom);
            return accumulator(mid !== undefined ? mid : initialValue, newAtom);
          },
          initialValue,
        );
      } else {
        res.mutate(
          oldKey,
          (prevAtom) => decumulator(prevAtom, oldAtom),
          initialValue,
        );
        res.mutate(
          newKey,
          (prevAtom) => accumulator(prevAtom, newAtom),
          initialValue,
        );
      }
    });
    this.postRemoveListeners.push((_hash, atom) =>
      res.mutate(
        keyFn(atom),
        (prevAtom) => decumulator(prevAtom, atom),
        initialValue,
      )
    );
    return res;
  }

  public innerJoin<RhsAtom, ReturnAtom>(
    rhs: Store2<RhsAtom>,
    transform: (lhs: Atom, rhs: RhsAtom) => ReturnAtom | undefined,
  ) {
    const res = new Store2<ReturnAtom>();
    this.entries.forEach((atom1, key) => {
      const atom2 = rhs.entries.get(key);
      if (atom2) {
        const hash = Hash.fromPrimitive(key);
        const val = transform(atom1, atom2);
        if (val !== undefined) {
          res.insert(hash, val);
        }
      }
    });
    this.postInsertListeners.push((hash, atom1) => {
      const atom2 = rhs.entries.get(hash.toPrimitive());
      if (atom2) {
        const val = transform(atom1, atom2);
        if (val !== undefined) {
          res.insert(hash, val);
        }
      }
    });
    rhs.postInsertListeners.push((hash, atom2) => {
      const atom1 = this.entries.get(hash.toPrimitive());
      if (atom1) {
        const val = transform(atom1, atom2);
        if (val !== undefined) {
          res.insert(hash, val);
        }
      }
    });
    this.postMutateListeners.push((hash, _oldAtom1, newAtom1) => {
      const atom2 = rhs.entries.get(hash.toPrimitive());
      if (atom2) {
        res.set(hash, transform(newAtom1, atom2));
      }
    });
    rhs.postMutateListeners.push((hash, _oldAtom2, newAtom2) => {
      const atom1 = this.entries.get(hash.toPrimitive());
      if (atom1) {
        res.set(hash, transform(atom1, newAtom2));
      }
    });
    this.postRemoveListeners.push((hash, atom1) => {
      const atom2 = rhs.entries.get(hash.toPrimitive());
      if (atom2) {
        const val = transform(atom1, atom2);
        if (val !== undefined) {
          res.remove(hash);
        }
      }
    });
    rhs.postRemoveListeners.push((hash, atom2) => {
      const atom1 = this.entries.get(hash.toPrimitive());
      if (atom1) {
        const val = transform(atom1, atom2);
        if (val !== undefined) {
          res.remove(hash);
        }
      }
    });
    return res;
  }
}
