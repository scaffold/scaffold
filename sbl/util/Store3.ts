import Hash, { HashPrimitive } from './Hash.ts';

export default abstract class Store3<Atom> {
  private entries: Map<HashPrimitive, Atom> = new Map();

  public get(hash: Hash) {
    return this.entries.get(hash.toPrimitive());
  }

  public insert(hash: Hash, atom: Atom) {
    const key = hash.toPrimitive();
    if (this.entries.has(key)) {
      throw new Error(`Store already has key ${hash.toHex()}`);
    }

    this.entries.set(key, atom);
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

    this.entries.delete(key);
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
          this.entries.set(key, newAtom);
        } else {
          this.entries.delete(key);
        }
      } else {
        if (newAtom !== undefined) {
          this.entries.set(key, newAtom);
        } else {
          throw new Error(`Shouldn't happen`);
        }
      }
    }
  }

  public map<ReturnAtom>(
    mapFn: (hash: Hash, atom: Atom) => ReturnAtom | undefined,
  ) {
    const res = new Store3<ReturnAtom>();
    res.sources.push(this);
    this.entries.forEach((atom, key) => {
      const hash = Hash.fromPrimitive(key);
      const val = mapFn(hash, atom);
      if (val !== undefined) {
        res.insert(hash, val);
      }
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
    const res = new Store3<ReturnAtom>();
    res.sources.push(this);
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
      const oldEmits: Map<HashPrimitive, EmitType[]> = new Map();
      emitFn(hash, oldAtom, (hash, val) => {
        const key = hash.toPrimitive();
        const e = oldEmits.get(key);
        if (e !== undefined) {
          e.push(val);
        } else {
          oldEmits.set(key, [val]);
        }
      });
      emitFn(hash, newAtom, (hash, val) => {
        const key = hash.toPrimitive();
        const e = oldEmits.get(key);
        res.mutate(
          hash,
          (prevAtom) =>
            accumulator(
              hash,
              e !== undefined
                ? e.reduce(
                  (prevAtom, val) => decumulator(hash, prevAtom, val),
                  prevAtom,
                )
                : prevAtom,
              val,
            ),
        );
        oldEmits.delete(key);
      });
      oldEmits.forEach((e, key) =>
        res.mutate(
          Hash.fromPrimitive(key),
          (prevAtom) =>
            e.reduce(
              (prevAtom, val) => decumulator(hash, prevAtom, val),
              prevAtom,
            ),
        )
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
    lhs: Store3<LhsAtom>,
    rhs: Store3<RhsAtom>,
    transform: (
      hash: Hash,
      lhs: LhsAtom,
      rhs: RhsAtom,
    ) => ReturnAtom | undefined,
  ) {
    const res = new Store3<ReturnAtom>();
    res.sources.push(lhs);
    res.sources.push(rhs);
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
    lhs: Store3<LhsAtom>,
    rhs: Store3<RhsAtom>,
    transform: (
      hash: Hash,
      lhs: LhsAtom,
      rhs: RhsAtom | undefined,
    ) => ReturnAtom | undefined,
  ) {
    const res = new Store3<ReturnAtom>();
    res.sources.push(lhs);
    res.sources.push(rhs);
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
    rhs.postRemoveListeners.push((hash, _atom2) => {
      const atom1 = lhs.entries.get(hash.toPrimitive());
      if (atom1 !== undefined) {
        res.set(hash, transform(hash, atom1, undefined));
      }
    });
    return res;
  }

  public static outerJoin<LhsAtom, RhsAtom, ReturnAtom>(
    lhs: Store3<LhsAtom>,
    rhs: Store3<RhsAtom>,
    transform: (
      hash: Hash,
      lhs: LhsAtom | undefined,
      rhs: RhsAtom | undefined,
    ) => ReturnAtom | undefined,
  ) {
    const res = new Store3<ReturnAtom>();
    res.sources.push(lhs);
    res.sources.push(rhs);
    lhs.entries.forEach((atom1, key) => {
      const atom2 = rhs.entries.get(key);
      const hash = Hash.fromPrimitive(key);
      const val = transform(hash, atom1, atom2);
      if (val !== undefined) {
        res.insert(hash, val);
      }
    });
    rhs.entries.forEach((atom2, key) => {
      if (!lhs.entries.has(key)) {
        const atom1 = lhs.entries.get(key);
        const hash = Hash.fromPrimitive(key);
        const val = transform(hash, atom1, atom2);
        if (val !== undefined) {
          res.insert(hash, val);
        }
      }
    });
    lhs.postInsertListeners.push((hash, atom1) => {
      const atom2 = rhs.entries.get(hash.toPrimitive());
      res.set(hash, transform(hash, atom1, atom2));
    });
    rhs.postInsertListeners.push((hash, atom2) => {
      const atom1 = lhs.entries.get(hash.toPrimitive());
      res.set(hash, transform(hash, atom1, atom2));
    });
    lhs.postMutateListeners.push((hash, _oldAtom1, newAtom1) => {
      const atom2 = rhs.entries.get(hash.toPrimitive());
      res.set(hash, transform(hash, newAtom1, atom2));
    });
    rhs.postMutateListeners.push((hash, _oldAtom2, newAtom2) => {
      const atom1 = lhs.entries.get(hash.toPrimitive());
      res.set(hash, transform(hash, atom1, newAtom2));
    });
    lhs.postRemoveListeners.push((hash, _atom1) => {
      const atom2 = rhs.entries.get(hash.toPrimitive());
      res.set(hash, transform(hash, undefined, atom2));
    });
    rhs.postRemoveListeners.push((hash, _atom2) => {
      const atom1 = lhs.entries.get(hash.toPrimitive());
      res.set(hash, transform(hash, atom1, undefined));
    });
    return res;
  }

  // public mapWithAccessor<RhsAtom, ReturnAtom>(
  //   memory: Store3<RhsAtom>,
  //   mapFn: (
  //     hash: Hash,
  //     atom: Atom,
  //     fetch: (hash: Hash) => RhsAtom | undefined,
  //   ) => ReturnAtom | undefined,
  // ) {
  //   const res = new Store3<ReturnAtom>();
  //   res.sources.push(this);
  //   res.sources.push(memory);
  //   const refs = new Map<HashPrimitive, Hash[]>();
  //   const rerun = (hash1: Hash) => {
  //     const key1 = hash1.toPrimitive();
  //     const atom1 = this.entries.get(key1)!;

  //     const val = mapFn(hash1, atom1, (hash2) => {
  //       const key2 = hash2.toPrimitive();
  //       const r = refs.get(key2);
  //       if (r !== undefined) {
  //         r.push(hash1);
  //       } else {
  //         refs.set(key2, [hash1]);
  //       }
  //       return memory.get(hash2);

  //       if (val !== undefined) {
  //         res.insert(hash1, val);
  //       }
  //     });
  //   };

  //   this.entries.forEach((atom1, key1) => {
  //     const hash1 = Hash.fromPrimitive(key1);
  //     const val = mapFn(hash1, atom1, (hash2) => {
  //       const key2 = hash2.toPrimitive();
  //       const r = refs.get(key2);
  //       if (r !== undefined) {
  //         r.push(hash1);
  //       } else {
  //         refs.set(key2, [hash1]);
  //       }
  //       return memory.get(hash2);
  //     });

  //     if (val !== undefined) {
  //       res.insert(hash1, val);
  //     }
  //   });
  //   this.postInsertListeners.push((hash1, atom1) => {
  //     const val = mapFn(hash1, atom1, (hash2) => {
  //       const key2 = hash2.toPrimitive();
  //       const r = refs.get(key2);
  //       if (r !== undefined) {
  //         r.push(hash1);
  //       } else {
  //         refs.set(key2, [hash1]);
  //       }
  //       return memory.get(hash2);
  //     });

  //     if (val !== undefined) {
  //       res.insert(hash1, val);
  //     }
  //   });
  //   memory.postInsertListeners.push((hash2, atom2) => {
  //     const key2 = hash2.toPrimitive();
  //     const r = refs.get(key2) || [];
  //     r.forEach(rerun);

  //     const atom1 = this.entries.get(hash.toPrimitive());
  //     if (atom1 !== undefined) {
  //       res.set(hash, transform(hash, atom1, atom2));
  //     }
  //   });
  //   this.postMutateListeners.push((hash, _oldAtom1, newAtom1) => {
  //     const atom2 = memory.entries.get(hash.toPrimitive());
  //     res.set(hash, transform(hash, newAtom1, atom2));
  //   });
  //   memory.postMutateListeners.push((hash, _oldAtom2, newAtom2) => {
  //     const atom1 = this.entries.get(hash.toPrimitive());
  //     if (atom1 !== undefined) {
  //       res.set(hash, transform(hash, atom1, newAtom2));
  //     }
  //   });
  //   this.postRemoveListeners.push((hash, atom1) => {
  //     const atom2 = memory.entries.get(hash.toPrimitive());
  //     if (atom2 !== undefined) {
  //       const val = transform(hash, atom1, atom2);
  //       if (val !== undefined) {
  //         res.remove(hash);
  //       }
  //     }
  //   });
  //   memory.postRemoveListeners.push((hash, atom2) => {
  //     const atom1 = this.entries.get(hash.toPrimitive());
  //     if (atom1 !== undefined) {
  //       res.set(hash, transform(hash, atom1, atom2));
  //     }
  //   });
  //   return res;
  // }
}
