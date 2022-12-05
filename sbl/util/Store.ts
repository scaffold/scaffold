import Hash, { HashPrimitive } from './Hash.ts';

export default class Store<Atom> {
  // TODO: Add modify method and listeners to speed up weight/cost/incentive propagation

  private entries: Map<HashPrimitive, Atom[]> = new Map();

  private preInsertListeners: ((hash: Hash, atom: Atom) => void)[] = [];
  private postInsertListeners: ((hash: Hash, atom: Atom) => void)[] = [];
  private preRemoveListeners: ((hash: Hash, atom: Atom) => void)[] = [];
  private postRemoveListeners: ((hash: Hash, atom: Atom) => void)[] = [];

  constructor(src?: Store<Atom>) {
    if (src) {
      this.entries = src.entries;
      this.preInsertListeners = src.preInsertListeners;
      this.postInsertListeners = src.postInsertListeners;
      this.preRemoveListeners = src.preRemoveListeners;
      this.postRemoveListeners = src.postRemoveListeners;
    }
  }

  public insert(hash: Hash, atom: Atom) {
    const key = hash.toPrimitive();
    const arr = this.entries.get(key);

    if (arr && arr.includes(atom)) {
      return;
    }

    this.preInsertListeners.forEach((fn) => fn(hash, atom));

    if (arr) {
      arr.push(atom);
    } else {
      this.entries.set(key, [atom]);
    }

    this.postInsertListeners.forEach((fn) => fn(hash, atom));
  }

  public remove(hash: Hash, predicate: (atom: Atom) => boolean) {
    this.preRemoveListeners.forEach((fn) => fn(hash, removed));

    const key = hash.toPrimitive();
    const arr = this.entries.get(key);
    let removed: Atom;
    if (arr) {
      const idx = arr.findIndex(predicate);
      if (idx === -1) {
        throw new Error(
          `Cannot remove item with hash ${key}; item doesn't exist`,
        );
      }
      if (arr.length === 1) {
        this.entries.delete(key);
        removed = arr[0];
      } else {
        removed = arr.splice(idx, 1)[0];
      }
    } else {
      throw new Error(
        `Cannot remove item with hash ${key}; no items with hash exists`,
      );
    }

    this.postRemoveListeners.forEach((fn) => fn(hash, removed));
  }

  public map<NewAtom>(
    fn: (
      hash: Hash,
      atom: Atom,
      emit: (hash: Hash, atom: NewAtom) => void,
    ) => void,
  ) {
    const res = new Store<NewAtom>();
    this.entries.forEach((atoms, key) =>
      atoms.forEach((atom) =>
        fn(
          Hash.fromPrimitive(key),
          atom,
          (hash, atom) => res.insert(hash, atom),
        )
      )
    );
    this.preInsertListeners.push((hash, atom) =>
      fn(hash, atom, (hash, atom) => res.insert(hash, atom))
    );
    this.postRemoveListeners.unshift((hash, atom) =>
      fn(hash, atom, (hash, atom) => res.remove(hash, (c) => c === atom))
    );
    return res;
  }

  public group<NewAtom>(
    fn: (
      hash: Hash,
      atoms: Atom[],
      emit: (hash: Hash, atom: NewAtom) => void,
    ) => void,
  ) {
    const res = new Store<NewAtom>();
    this.entries.forEach((atoms, key) =>
      fn(Hash.fromPrimitive(key), atoms, (hash, atom) => res.insert(hash, atom))
    );
    this.preInsertListeners.push((hash, _atom) => {
      const arr = this.entries.get(hash.toPrimitive());
      if (arr) {
        fn(hash, arr, (hash, atom) => res.remove(hash, (c) => c === atom));
      }
    });
    this.postInsertListeners.push((hash, _atom) =>
      fn(
        hash,
        this.entries.get(hash.toPrimitive())!,
        (hash, atom) => res.insert(hash, atom),
      )
    );
    this.preRemoveListeners.unshift((hash, _atom) =>
      fn(
        hash,
        this.entries.get(hash.toPrimitive())!,
        (hash, atom) => res.remove(hash, (c) => c === atom),
      )
    );
    this.postRemoveListeners.unshift((hash, _atom) => {
      const arr = this.entries.get(hash.toPrimitive());
      if (arr) {
        fn(hash, arr, (hash, atom) => res.insert(hash, atom));
      }
    });
    return res;
  }

  public innerJoin<Atom2>(rhs: Store<Atom2>) {
    const res = new Store<[Atom, Atom2]>();
    this.entries.forEach((e1, key) => {
      const e2 = rhs.entries.get(key);
      if (e2) {
        const hash = Hash.fromPrimitive(key);
        e1.forEach((a1) => e2.forEach((a2) => res.insert(hash, [a1, a2])));
      }
    });
    this.preInsertListeners.push((hash, atom1) => {
      const e2 = rhs.entries.get(hash.toPrimitive());
      if (e2) {
        e2.forEach((atom2) => res.insert(hash, [atom1, atom2]));
      }
    });
    rhs.preInsertListeners.push((hash, atom2) => {
      const e1 = this.entries.get(hash.toPrimitive());
      if (e1) {
        e1.forEach((atom1) => res.insert(hash, [atom1, atom2]));
      }
    });
    this.postRemoveListeners.unshift((hash, atom1) => {
      const e2 = rhs.entries.get(hash.toPrimitive());
      if (e2) {
        e2.forEach((atom2) =>
          res.remove(hash, ([c1, c2]) => c1 === atom1 && c2 === atom2)
        );
      }
    });
    rhs.postRemoveListeners.unshift((hash, atom2) => {
      const e1 = this.entries.get(hash.toPrimitive());
      if (e1) {
        e1.forEach((atom1) =>
          res.remove(hash, ([c1, c2]) => c1 === atom1 && c2 === atom2)
        );
      }
    });
    return res;
  }

  public leftJoin<Atom2>(rhs: Store<Atom2>) {
    const res = new Store<[Atom, Atom2 | null]>();
    this.entries.forEach((e1, key) => {
      const e2 = rhs.entries.get(key);
      const hash = Hash.fromPrimitive(key);
      if (e2) {
        e1.forEach((a1) => e2.forEach((a2) => res.insert(hash, [a1, a2])));
      } else {
        e1.forEach((a1) => res.insert(hash, [a1, null]));
      }
    });
    this.preInsertListeners.push((hash, atom1) => {
      const e2 = rhs.entries.get(hash.toPrimitive());
      if (e2) {
        e2.forEach((atom2) => res.insert(hash, [atom1, atom2]));
      } else {
        res.insert(hash, [atom1, null]);
      }
    });
    rhs.preInsertListeners.push((hash, atom2) => {
      const e1 = this.entries.get(hash.toPrimitive());
      if (e1) {
        if (rhs.entries.has(hash.toPrimitive())) {
          e1.forEach((atom1) => res.insert(hash, [atom1, atom2]));
        } else {
          e1.forEach((atom1) => {
            // First item; we need to remove the null entry from before
            res.remove(hash, ([c1, c2]) => c1 === atom1 && c2 === null);
            res.insert(hash, [atom1, atom2]);
          });
        }
      }
    });
    this.postRemoveListeners.unshift((hash, atom1) => {
      const e2 = rhs.entries.get(hash.toPrimitive());
      if (e2) {
        e2.forEach((atom2) =>
          res.remove(hash, ([c1, c2]) => c1 === atom1 && c2 === atom2)
        );
      } else {
        res.remove(hash, ([c1, c2]) => c1 === atom1 && c2 === null);
      }
    });
    rhs.postRemoveListeners.unshift((hash, atom2) => {
      const e1 = this.entries.get(hash.toPrimitive());
      if (e1) {
        if (rhs.entries.has(hash.toPrimitive())) {
          e1.forEach((atom1) =>
            res.remove(hash, ([c1, c2]) => c1 === atom1 && c2 === atom2)
          );
        } else {
          e1.forEach((atom1) => {
            res.remove(hash, ([c1, c2]) => c1 === atom1 && c2 === atom2);
            res.insert(hash, [atom1, null]);
          });
        }
      }
    });
    return res;
  }

  public rightJoin<Atom2>(rhs: Store<Atom2>) {
    const res = new Store<[Atom | null, Atom2]>();
    rhs.entries.forEach((e2, key) => {
      const e1 = this.entries.get(key);
      const hash = Hash.fromPrimitive(key);
      if (e1) {
        e1.forEach((a1) => e2.forEach((a2) => res.insert(hash, [a1, a2])));
      } else {
        e2.forEach((a2) => res.insert(hash, [null, a2]));
      }
    });
    this.preInsertListeners.push((hash, atom1) => {
      const e2 = rhs.entries.get(hash.toPrimitive());
      if (e2) {
        if (this.entries.has(hash.toPrimitive())) {
          e2.forEach((atom2) => res.insert(hash, [atom1, atom2]));
        } else {
          e2.forEach((atom2) => {
            // First item; we need to remove the null entry from before
            res.remove(hash, ([c1, c2]) => c1 === null && c2 === atom2);
            res.insert(hash, [atom1, atom2]);
          });
        }
      }
    });
    rhs.preInsertListeners.push((hash, atom2) => {
      const e1 = this.entries.get(hash.toPrimitive());
      if (e1) {
        e1.forEach((atom1) => res.insert(hash, [atom1, atom2]));
      } else {
        res.insert(hash, [null, atom2]);
      }
    });
    this.postRemoveListeners.unshift((hash, atom1) => {
      const e2 = rhs.entries.get(hash.toPrimitive());
      if (e2) {
        if (this.entries.has(hash.toPrimitive())) {
          e2.forEach((atom2) =>
            res.remove(hash, ([c1, c2]) => c1 === atom1 && c2 === atom2)
          );
        } else {
          e2.forEach((atom2) => {
            res.remove(hash, ([c1, c2]) => c1 === atom1 && c2 === atom2);
            res.insert(hash, [null, atom2]);
          });
        }
      }
    });
    rhs.postRemoveListeners.unshift((hash, atom2) => {
      const e1 = this.entries.get(hash.toPrimitive());
      if (e1) {
        e1.forEach((atom1) =>
          res.remove(hash, ([c1, c2]) => c1 === atom1 && c2 === atom2)
        );
      } else {
        res.remove(hash, ([c1, c2]) => c1 === null && c2 === atom2);
      }
    });
    return res;
  }
}

/*
class X extends Store<{}> {
  constructor(private ctx: Context) {
    super(this.ctx.get(BlockRegistry).);
  }
}

block = {
  verifier: x,
  incentive: [{verifier: y, amount}]
}

generator = {
  verifier: y
}

NOT block2 = {
  verifier: y
}
*/

// verifierToIncentivizor = blocks.each((block, emit) =>
//   block.incentives.forEach((incentive) => emit(hash(incentive.verifier), block))
// );
// generators = blocks.each((block, emit) =>
//   isGenerator(block) && emit(hash(block.verifier), block.generator)
// );
// verifierToIncentivizor.join(generators).leftJoin(
//   blocks.each((block, emit) => emit(hash(block.verifier), block)),
// ).on((verifier, [[incentivizor, generator], existing]) =>
//   !existing && generator(verifier)
// );

// If a peer sends a lot of blocks, drop them unless they're useful?
// Propagate value back to each store. Value is only meaningful per-store. If I had dropped this element when I got it, what value would I have lost?
// Can do ML on each store individually to understand what to keep and what to drop.
