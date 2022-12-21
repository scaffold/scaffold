import Hash, { HashPrimitive } from './Hash.ts';
import { getOrCreate } from './map.ts';

// type NonUndefined<T> = T extends undefined ? never : T;

export default class Store2<Atom> {
  private entries: Map<HashPrimitive, Atom> = new Map();

  // TODO: Maybe eliminate storing entries when we don't need it.
  // Pass the removed value to .remove()
  private needsEntries = false;

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
      this.swap(src);
    }
  }

  public swap(src: Store2<Atom>) {
    this.entries = src.entries;
    this.preInsertListeners = src.preInsertListeners;
    this.postInsertListeners = src.postInsertListeners;
    this.preMutateListeners = src.preMutateListeners;
    this.postMutateListeners = src.postMutateListeners;
    this.preRemoveListeners = src.preRemoveListeners;
    this.postRemoveListeners = src.postRemoveListeners;
  }

  public get(hash: Hash) {
    return this.entries.get(hash.toPrimitive());
  }

  public onMutate(
    cb: (
      hash: Hash,
      oldAtom: Atom | undefined,
      newAtom: Atom | undefined,
    ) => void,
  ) {
    this.postInsertListeners.push((hash, atom) => cb(hash, undefined, atom));
    this.postMutateListeners.push(cb);
    this.postRemoveListeners.push((hash, atom) => cb(hash, atom, undefined));
    this.entries.forEach((atom, key) =>
      cb(Hash.fromPrimitive(key), undefined, atom)
    );
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
    mutator: (prevAtom: Atom | undefined) => Atom | undefined,
  ) {
    const key = hash.toPrimitive();
    const oldAtom = this.entries.get(key);
    const newAtom = mutator(oldAtom);
    this.update(key, hash, oldAtom, newAtom);
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
    this.update(key, hash, oldAtom, newAtom);
  }

  private update(
    key: HashPrimitive,
    hash: Hash,
    oldAtom: Atom | undefined,
    newAtom: Atom | undefined,
  ) {
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

  public map<ReturnAtom>(
    mapFn: (hash: Hash, atom: Atom) => ReturnAtom | undefined,
  ) {
    const res = new Store2<ReturnAtom>();
    this.entries.forEach((atom, key) => {
      const hash = Hash.fromPrimitive(key);
      res.set(hash, mapFn(hash, atom));
    });
    this.postInsertListeners.push((hash, atom) =>
      res.set(hash, mapFn(hash, atom))
    );
    this.postMutateListeners.push((hash, _oldAtom, newAtom) =>
      res.set(hash, mapFn(hash, newAtom))
    );
    this.postRemoveListeners.push((hash, atom) =>
      res.set(hash, mapFn(hash, atom))
    );
    return res;
  }

  public groupBy<EmitType, ReturnAtom = EmitType>(
    emitFn: (
      hash: Hash,
      atom: Atom,
      emit: (key: Hash, value: EmitType) => void,
    ) => void,
    accumulator: (
      hash: Hash,
      aggregation: ReturnAtom | undefined,
      emittedValue: EmitType,
    ) => ReturnAtom | undefined,
    decumulator: (
      hash: Hash,
      aggregation: ReturnAtom | undefined,
      emittedValue: EmitType,
    ) => ReturnAtom | undefined,
  ) {
    const res = new Store2<ReturnAtom>();
    this.entries.forEach((atom, key) =>
      emitFn(
        Hash.fromPrimitive(key),
        atom,
        (key, val) =>
          res.mutate(key, (prevAtom) => accumulator(key, prevAtom, val)),
      )
    );
    this.postInsertListeners.push((hash, atom) =>
      emitFn(
        hash,
        atom,
        (key, val) =>
          res.mutate(key, (prevAtom) => accumulator(hash, prevAtom, val)),
      )
    );
    this.postMutateListeners.push((hash, oldAtom, newAtom) => {
      // TODO: If keys are all the same, fast-path so descendants only get called once
      // const kvs: [Hash, EmitType][] = [];
      emitFn(
        hash,
        oldAtom,
        (key, val) =>
          res.mutate(key, (prevAtom) => decumulator(hash, prevAtom, val)),
      );
      emitFn(
        hash,
        newAtom,
        (key, val) =>
          res.mutate(key, (prevAtom) => accumulator(hash, prevAtom, val)),
      );
    });
    this.postRemoveListeners.push((hash, atom) =>
      emitFn(
        hash,
        atom,
        (key, val) =>
          res.mutate(key, (prevAtom) => decumulator(hash, prevAtom, val)),
      )
    );
    return res;
  }

  public static innerJoin<LhsAtom, RhsAtom, ReturnAtom>(
    lhs: Store2<LhsAtom>,
    rhs: Store2<RhsAtom>,
    transform: (
      hash: Hash,
      lhs: LhsAtom,
      rhs: RhsAtom,
    ) => ReturnAtom | undefined,
  ) {
    const res = new Store2<ReturnAtom>();
    lhs.entries.forEach((atom1, key) => {
      const atom2 = rhs.entries.get(key);
      if (atom2 !== undefined) {
        const hash = Hash.fromPrimitive(key);
        const val = transform(hash, atom1, atom2);
        if (val !== undefined) {
          res.insert(hash, val);
        }
      }
    });
    lhs.postInsertListeners.push((hash, atom1) => {
      const atom2 = rhs.entries.get(hash.toPrimitive());
      if (atom2 !== undefined) {
        const val = transform(hash, atom1, atom2);
        if (val !== undefined) {
          res.insert(hash, val);
        }
      }
    });
    rhs.postInsertListeners.push((hash, atom2) => {
      const atom1 = lhs.entries.get(hash.toPrimitive());
      if (atom1 !== undefined) {
        const val = transform(hash, atom1, atom2);
        if (val !== undefined) {
          res.insert(hash, val);
        }
      }
    });
    lhs.postMutateListeners.push((hash, _oldAtom1, newAtom1) => {
      const atom2 = rhs.entries.get(hash.toPrimitive());
      if (atom2 !== undefined) {
        res.set(hash, transform(hash, newAtom1, atom2));
      }
    });
    rhs.postMutateListeners.push((hash, _oldAtom2, newAtom2) => {
      const atom1 = lhs.entries.get(hash.toPrimitive());
      if (atom1 !== undefined) {
        res.set(hash, transform(hash, atom1, newAtom2));
      }
    });
    lhs.postRemoveListeners.push((hash, atom1) => {
      const atom2 = rhs.entries.get(hash.toPrimitive());
      if (atom2 !== undefined) {
        const val = transform(hash, atom1, atom2);
        if (val !== undefined) {
          res.remove(hash);
        }
      }
    });
    rhs.postRemoveListeners.push((hash, atom2) => {
      const atom1 = lhs.entries.get(hash.toPrimitive());
      if (atom1 !== undefined) {
        const val = transform(hash, atom1, atom2);
        if (val !== undefined) {
          res.remove(hash);
        }
      }
    });
    return res;
  }

  public static leftJoin<LhsAtom, RhsAtom, ReturnAtom>(
    lhs: Store2<LhsAtom>,
    rhs: Store2<RhsAtom>,
    transform: (
      hash: Hash,
      lhs: LhsAtom,
      rhs: RhsAtom | undefined,
    ) => ReturnAtom | undefined,
  ) {
    const res = new Store2<ReturnAtom>();
    lhs.entries.forEach((atom1, key) => {
      const atom2 = rhs.entries.get(key);
      const hash = Hash.fromPrimitive(key);
      const val = transform(hash, atom1, atom2);
      if (val !== undefined) {
        res.insert(hash, val);
      }
    });
    lhs.postInsertListeners.push((hash, atom1) => {
      const atom2 = rhs.entries.get(hash.toPrimitive());
      const val = transform(hash, atom1, atom2);
      if (val !== undefined) {
        res.insert(hash, val);
      }
    });
    rhs.postInsertListeners.push((hash, atom2) => {
      const atom1 = lhs.entries.get(hash.toPrimitive());
      if (atom1 !== undefined) {
        res.set(hash, transform(hash, atom1, atom2));
      }
    });
    lhs.postMutateListeners.push((hash, _oldAtom1, newAtom1) => {
      const atom2 = rhs.entries.get(hash.toPrimitive());
      res.set(hash, transform(hash, newAtom1, atom2));
    });
    rhs.postMutateListeners.push((hash, _oldAtom2, newAtom2) => {
      const atom1 = lhs.entries.get(hash.toPrimitive());
      if (atom1 !== undefined) {
        res.set(hash, transform(hash, atom1, newAtom2));
      }
    });
    lhs.postRemoveListeners.push((hash, atom1) => {
      const atom2 = rhs.entries.get(hash.toPrimitive());
      if (atom2 !== undefined) {
        const val = transform(hash, atom1, atom2);
        if (val !== undefined) {
          res.remove(hash);
        }
      }
    });
    rhs.postRemoveListeners.push((hash, atom2) => {
      const atom1 = lhs.entries.get(hash.toPrimitive());
      if (atom1 !== undefined) {
        res.set(hash, transform(hash, atom1, atom2));
      }
    });
    return res;
  }
}
