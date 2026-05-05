// Protocol spec: docs/protocol/weight-propagation.md
//
// Pure logic for derived weight vectors and descendant weight queries.
// Operates over an opaque NodeId via a provider; no awareness of canonicality
// (descendant weight feeds canonicality, so reading it would be circular).
//
// All choices over competing neighbours use max -- never sum -- so weight is
// never duplicated through diamond/competing-aggregator structures.

/**
 * Provider exposing the minimal neighbourhood structure needed to propagate
 * weight. Implementations adapt Block / Draft / BlockStore (see
 * NodeWeightsService) but the module knows nothing about either.
 *
 * `weightVector(B)` is the *aggregated subtree's* contribution attributed to
 * B's anchor chain -- it does NOT include B.selfWeight. weightVector[0] lands
 * on B.anchor, weightVector[1] on B.anchor.anchor, etc. Empty for leaves.
 */
export interface NodeWeightsProvider<NodeId> {
  /** B's own work (verification cost). Scalar, not in weightVector. */
  selfWeight(id: NodeId): number;
  /** Aggregated subtree's contributions, indexed by B's anchor depth. */
  weightVector(id: NodeId): number[];
  /** B's direct aggregates (transitive children walked by the module). */
  aggregates(id: NodeId): NodeId[];
  /** Blocks `C` with `C.anchor === B`. */
  anchoringChildren(id: NodeId): NodeId[];
  /** Blocks that have B in their aggregates. */
  parents(id: NodeId): NodeId[];
  /** B's anchor (used to walk between blocks for relative-depth math). */
  anchor(id: NodeId): NodeId | null;
  /** Stable key for memoisation / set membership; also doubles as identity. */
  key(id: NodeId): string;
}

const recursionSentinel = Symbol('RecursionSentinel');

/**
 * Weight propagation module. Stateless across queries (memoisation is
 * per-call); call sites that want incremental update can wrap with caching.
 */
export class NodeWeightsModule<NodeId> {
  constructor(private readonly p: NodeWeightsProvider<NodeId>) {}

  // -- Propagation: derived weight vector -----------------------------------

  /**
   * `derivedWeightVector(B)`:
   *   [0] = weight at B AND at all chain descendants of B in B's subtree
   *   [k] = weight at B's k-th ancestor (a single chain block)            (k >= 1)
   *
   * Recurrence (with C* = heaviest anchor child of B):
   *   [0] = B.selfWeight + derivedWeight(C*)[1] + derivedWeight(C*)[0]
   *   [k] = B.weightVector[k - 1] + derivedWeight(C*)[k + 1]              (k >= 1)
   *
   * Note the asymmetry: [0] absorbs both C*'s [1] (its contribution to B)
   * and C*'s [0] (which itself accumulates deeper chain weight). [k >= 1]
   * is a single chain block so it just takes C*'s shifted entry.
   *
   * "Heaviest" = max over `sum(derivedWeightVector(C))` for C in
   * anchoringChildren(B). At most one wins -- this is the no-double-count
   * defence against competing aggregators.
   */
  derivedWeightVector(id: NodeId): number[] {
    return this.computeDerived(id, new Map());
  }

  private computeDerived(
    id: NodeId,
    memo: Map<string, number[] | typeof recursionSentinel>,
  ): number[] {
    const k = this.p.key(id);
    const cached = memo.get(k);
    if (cached === recursionSentinel) throw new Error('Cycle detected');
    if (cached) return cached;
    // Cycle guard: shouldn't happen on a real DAG, but defensive.
    memo.set(k, recursionSentinel);

    const sw = this.p.selfWeight(id);
    const wv = this.p.weightVector(id);

    // Own contribution: [selfWeight, weightVector[0], weightVector[1], ...]
    const own: number[] = [sw, ...wv];

    // Pick heaviest anchoring child.
    const children = this.p.anchoringChildren(id);
    let bestVec: number[] = [];
    let bestSum = -1;
    for (const c of children) {
      const v = this.computeDerived(c, memo);
      const s = sumVec(v);
      if (s > bestSum) {
        bestSum = s;
        bestVec = v;
      }
    }

    // Shift down by 1 for k >= 1 (child's entry k lands on B's entry k - 1).
    const out = addVecs(own, bestVec.slice(1));
    // Plus: the child's [0] (= weight at C and all deeper chain blocks in
    // C's subtree) is itself part of B's [0], since C is a chain descendant
    // of B in B's anchor subtree.
    if (bestVec.length > 0) out[0] = (out[0] ?? 0) + bestVec[0];

    memo.set(k, out);
    return out;
  }

  // -- Query: descendant weight for any block -------------------------------

  /**
   * `descendantWeight(X)` = max over all neighbour branches of the weight
   * that depends on X being canonical.
   *
   * Neighbours are X's parents (aggregators) and X's anchoring children. Both
   * kinds of branch keep blocks alive only if X is alive. The single max
   * across all branches avoids double-counting that would occur if we summed
   * a parent's branch (which already encodes some anchor-children's weight
   * via `weightVector`) with those anchor-children's branches directly.
   */
  descendantWeight(id: NodeId): number {
    let best = 0;

    for (const c of this.p.anchoringChildren(id)) {
      // C anchors to X. derivedWeightVector(C) gives weight at each of C's
      // ancestors, indexed from C itself. Entry 0 = at C (in X's dependent
      // set, since C anchors to X). Entry 1 = at X. Above that = at X's
      // ancestors, which do NOT depend on X. So we take [0] + [1] only.
      const v = this.derivedWeightVector(c);
      const candidate = (v[0] ?? 0) + (v[1] ?? 0);
      if (candidate > best) best = candidate;
    }

    for (const p of this.p.parents(id)) {
      const candidate = this.weightThroughParent(id, p);
      if (candidate > best) best = candidate;
    }

    return best;
  }

  /**
   * Weight contributed to X's dependent set by going through aggregator P.
   *
   * P depends on X (P aggregates X transitively), so P.selfWeight + every
   * block in P's aggregated subtree that is X or an anchor-descendant of X
   * contributes. The contribution from each such block Y is Y's weightVector
   * entries that attribute to X (or to chain blocks between X and Y).
   *
   * The "extension into P's other neighbours" reduces to descendantWeight(P)
   * itself: it iterates the same anchor-children and parents, and those sets
   * are disjoint from P's aggregated subtree (anchor-children of P are not
   * in aggregates(P); parents of P aggregate P, they don't sit inside it).
   */
  private weightThroughParent(x: NodeId, p: NodeId): number {
    let total = this.p.selfWeight(p);

    for (const y of this.p.aggregates(p)) {
      const dxy = this.depthFromTo(y, x);
      if (dxy === null || dxy === 0) continue; // not an anchor descendant of X (or is X).
      const wv = this.p.weightVector(y);
      // Y.weightVector[k] attributes to Y's (k+1)-th ancestor; we want
      // entries at X or between Y and X, i.e., k in [0 .. dxy - 1].
      for (let k = 0; k < dxy && k < wv.length; k++) total += wv[k];
      total += this.p.selfWeight(y);
    }

    return total + this.descendantWeight(p);
  }

  // -- Helpers --------------------------------------------------------------

  /**
   * Number of anchor-chain hops from `from` up to `to`, or null if `to` is
   * not on `from`'s anchor chain. depthFromTo(X, X) = 0.
   */
  private depthFromTo(from: NodeId, to: NodeId): number | null {
    let cur: NodeId | null = from;
    let d = 0;
    const toKey = this.p.key(to);
    while (cur !== null) {
      if (this.p.key(cur) === toKey) return d;
      cur = this.p.anchor(cur);
      d++;
      if (d > 1_000_000) return null; // pathological safety bound
    }
    return null;
  }
}

// -- Vector utilities (module-private) --------------------------------------

function sumVec(v: number[]): number {
  let s = 0;
  for (const x of v) s += x;
  return s;
}

function addVecs(a: number[], b: number[]): number[] {
  const n = Math.max(a.length, b.length);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}
