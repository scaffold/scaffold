import { assertAlmostEquals, assertEquals } from '@std/assert';
import { Hash, HashPrimitive } from '../src/util/Hash.ts';
import { SamplingModule, SamplingProvider } from '../src/core/SamplingModule.ts';

// -- Test helpers ------------------------------------------------

interface TestBlock {
  hash: Hash;
  aggregates: Hash[];
  selfWeight: number;
  subtreeWeight: number;
}

class TestProvider implements SamplingProvider<TestBlock> {
  private blocks = new Map<HashPrimitive, TestBlock>();
  /** Override subtree weights for aggregates that might be missing. */
  private subtreeWeights = new Map<HashPrimitive, number>();

  add(block: TestBlock): void {
    this.blocks.set(block.hash.toPrimitive(), block);
  }

  remove(hash: Hash): void {
    this.blocks.delete(hash.toPrimitive());
  }

  setSubtreeWeight(hash: Hash, weight: number): void {
    this.subtreeWeights.set(hash.toPrimitive(), weight);
  }

  getBlock(hash: Hash): TestBlock | undefined {
    return this.blocks.get(hash.toPrimitive());
  }

  getHash(block: TestBlock): Hash {
    return block.hash;
  }

  getAggregates(block: TestBlock): Hash[] {
    return block.aggregates;
  }

  getSelfWeight(block: TestBlock): number {
    return block.selfWeight;
  }

  getAggregateWeights(block: TestBlock): number[] {
    return block.aggregates.map((aggHash) => {
      const override = this.subtreeWeights.get(aggHash.toPrimitive());
      if (override !== undefined) return override;
      const agg = this.blocks.get(aggHash.toPrimitive());
      return agg ? agg.subtreeWeight : 0;
    });
  }
}

const h = (name: string): Hash => Hash.digest(name);

function block(
  name: string,
  selfWeight: number,
  children: TestBlock[] = [],
): TestBlock {
  const subtreeWeight = selfWeight + children.reduce((s, c) => s + c.subtreeWeight, 0);
  return {
    hash: h(name),
    aggregates: children.map((c) => c.hash),
    selfWeight,
    subtreeWeight,
  };
}

/** Create a seeded PRNG that returns values from a fixed sequence. */
function seededRandom(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

function setup(
  blocks: TestBlock[],
  random?: () => number,
): { provider: TestProvider; module: SamplingModule<TestBlock> } {
  const provider = new TestProvider();
  const module = new SamplingModule(provider, random);
  for (const b of blocks) {
    provider.add(b);
  }
  for (const b of blocks) {
    module.addBlock(b.hash);
  }
  return { provider, module };
}

/** Compute expected swing formula: 2I(r+1)(q-r+1) / [(q+2)^2(q+3)] */
function swing(I: number, q: number, r: number): number {
  const alpha = r + 1;
  const beta = q - r + 1;
  const s = alpha + beta;
  return (2 * I * alpha * beta) / (s * s * (s + 1));
}

// -- Probe descent -----------------------------------------------

Deno.test('Sampling: descent distributes proportionally to weight', () => {
  const A = block('A', 40);
  const B = block('B', 30);
  const G = block('G', 10, [A, B]); // total: 80

  let aCount = 0;
  let bCount = 0;
  let selfCount = 0;
  const N = 5000;

  for (let i = 0; i < N; i++) {
    const { module } = setup([G, A, B]);
    module.initSample(G.hash);
    const q = module.getSampleState(G.hash)!.queries[0];
    if (q === 0) aCount++;
    else if (q === 1) bCount++;
    else selfCount++;
  }

  // A ~50%, B ~37.5%, self ~12.5% (tolerance +/-5%)
  assertEquals(aCount / N > 0.45, true, `A fraction ${aCount / N}`);
  assertEquals(aCount / N < 0.55, true, `A fraction ${aCount / N}`);
  assertEquals(bCount / N > 0.32, true, `B fraction ${bCount / N}`);
  assertEquals(bCount / N < 0.43, true, `B fraction ${bCount / N}`);
  assertEquals(selfCount / N > 0.07, true, `self fraction ${selfCount / N}`);
  assertEquals(selfCount / N < 0.18, true, `self fraction ${selfCount / N}`);
});

Deno.test('Sampling: deterministic descent picks aggregate when random < agg weight', () => {
  const A = block('A', 40);
  const B = block('B', 30);
  const G = block('G', 10, [A, B]);
  const { module } = setup([G, A, B], seededRandom([0.0]));

  module.initSample(G.hash);
  assertEquals(module.getSampleState(G.hash)!.queries[0], 0);
});

Deno.test('Sampling: deterministic descent picks self when in self-weight range', () => {
  const A = block('A', 40);
  const B = block('B', 30);
  const G = block('G', 10, [A, B]); // self range: [70/80, 80/80] = [0.875, 1.0]
  const { module } = setup([G, A, B], seededRandom([0.999]));

  module.initSample(G.hash);
  assertEquals(module.getSampleState(G.hash)!.queries[0], -1);
});

Deno.test('Sampling: block with selfWeight > 0 and no aggregates is always terminal', () => {
  const G = block('G', 10);
  const { module } = setup([G], seededRandom([0.5]));

  const result = module.initSample(G.hash);
  assertEquals(result.terminal, true);
  if (result.terminal) assertEquals(Hash.equals(result.blockHash, G.hash), true);
  assertEquals(module.getSampleState(G.hash)!.queries[0], -1);
});

Deno.test('Sampling: block with selfWeight=0 always descends to aggregates', () => {
  const A = block('A', 50);
  const G = block('G', 0, [A]);
  const { module } = setup([G, A], seededRandom([0.5]));

  for (let i = 0; i < 100; i++) {
    module.initSample(G.hash);
  }

  const state = module.getSampleState(G.hash)!;
  for (const q of state.queries) {
    assertEquals(q, 0);
  }
});

Deno.test('Sampling: leaf block (no aggregates) is always terminal', () => {
  const L = block('L', 50);
  const { module } = setup([L], seededRandom([0.1]));
  const result = module.initSample(L.hash);
  assertEquals(result.terminal, true);
});

Deno.test('Sampling: recursively descends through multiple levels', () => {
  const A1 = block('A1', 50);
  const A = block('A', 0, [A1]);
  const G = block('G', 0, [A]);
  const { module } = setup([G, A, A1], seededRandom([0.5, 0.5, 0.5]));

  const result = module.initSample(G.hash);
  assertEquals(result.terminal, true);
  if (result.terminal) assertEquals(Hash.equals(result.blockHash, A1.hash), true);

  assertEquals(module.getSampleState(G.hash)!.queries, [0]);
  assertEquals(module.getSampleState(A.hash)!.queries, [0]);
  assertEquals(module.getSampleState(A1.hash)!.queries, [-1]);
});

Deno.test('Sampling: multiple aggregates receive proportional probes', () => {
  const A = block('A', 60);
  const B = block('B', 30);
  const C = block('C', 10);
  const G = block('G', 0, [A, B, C]);

  const counts = [0, 0, 0];
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const { module } = setup([G, A, B, C]);
    module.initSample(G.hash);
    counts[module.getSampleState(G.hash)!.queries[0]]++;
  }

  assertEquals(counts[0] / N > 0.55, true, `A fraction ${counts[0] / N}`);
  assertEquals(counts[0] / N < 0.65, true, `A fraction ${counts[0] / N}`);
  assertEquals(counts[1] / N > 0.25, true, `B fraction ${counts[1] / N}`);
  assertEquals(counts[1] / N < 0.35, true, `B fraction ${counts[1] / N}`);
  assertEquals(counts[2] / N > 0.05, true, `C fraction ${counts[2] / N}`);
  assertEquals(counts[2] / N < 0.15, true, `C fraction ${counts[2] / N}`);
});

Deno.test('Sampling: ensures child has at least as many probes as parent sent', () => {
  const A = block('A', 100);
  const G = block('G', 0, [A]);
  const { module } = setup([G, A], seededRandom([0.5]));

  for (let i = 0; i < 5; i++) module.initSample(G.hash);

  assertEquals(module.getSampleState(A.hash)!.queries.length >= 5, true);
});

// -- countVerifications with limit --------------------------------

Deno.test('Sampling: countVerifications respects limit from parent', () => {
  const A = block('A', 100);
  const G = block('G', 0, [A]);
  const { module } = setup([G, A], seededRandom([0.5]));

  // Independently probe A 10 times
  for (let i = 0; i < 10; i++) module.initSample(A.hash);
  module.recordVerification(A.hash, true);
  assertEquals(module.countVerifications(A.hash, 10), 10);

  // Parent G probes A twice
  module.initSample(G.hash);
  module.initSample(G.hash);

  // Parent's perspective: only 2 of A's results count
  assertEquals(module.countVerifications(G.hash, 2), 2);
});

Deno.test('Sampling: self-verification counted only for self-queries', () => {
  const A = block('A', 50);
  const G = block('G', 50, [A]);
  // 0.0 -> aggregate, 0.99 -> self
  const { module } = setup([G, A], seededRandom([0.0, 0.99]));

  module.initSample(G.hash); // -> A
  module.initSample(G.hash); // -> self
  module.recordVerification(G.hash, true);
  module.recordVerification(A.hash, true);

  assertEquals(module.countVerifications(G.hash, 2), 2);
  assertEquals(module.countVerifications(G.hash, 1), 1); // only the first query (A)
});

Deno.test('Sampling: countVerifications returns 0 when nothing verified', () => {
  const { module } = setup([block('A', 100)], seededRandom([0.5]));
  module.initSample(h('A'));
  assertEquals(module.countVerifications(h('A'), 1), 0);
});

// -- Weight factor ------------------------------------------------

Deno.test('Sampling: 0 queries gives weight factor 0', () => {
  const { module } = setup([block('A', 100)]);
  assertEquals(module.getWeightFactor(h('A')), 0);
});

Deno.test('Sampling: all verified gives weight factor 1.0', () => {
  const { module } = setup([block('A', 100)], seededRandom([0.5]));
  for (let i = 0; i < 5; i++) module.initSample(h('A'));
  module.recordVerification(h('A'), true);
  assertAlmostEquals(module.getWeightFactor(h('A')), 1.0);
});

Deno.test('Sampling: mixed verification gives correct ratio', () => {
  const A1 = block('A1', 50);
  const A2 = block('A2', 50);
  const G = block('G', 0, [A1, A2]);
  const { module } = setup([G, A1, A2]);

  // Use real randomness and run many probes for convergence
  for (let i = 0; i < 200; i++) module.initSample(G.hash);
  module.recordVerification(A1.hash, true);
  // A1 verified, A2 not -> converges to 0.5

  const wf = module.getWeightFactor(G.hash);
  assertEquals(wf > 0.40, true, `weight factor ${wf} should be > 0.40`);
  assertEquals(wf < 0.60, true, `weight factor ${wf} should be < 0.60`);
});

Deno.test('Sampling: weight factor for unknown block is 0', () => {
  const provider = new TestProvider();
  const module = new SamplingModule(provider);
  assertEquals(module.getWeightFactor(h('unknown')), 0);
});

// -- Missing blocks -----------------------------------------------

Deno.test('Sampling: missing block result is non-terminal with reason missing', () => {
  const A: TestBlock = {
    hash: h('A'),
    aggregates: [h('B')],
    selfWeight: 10,
    subtreeWeight: 110,
  };
  const provider = new TestProvider();
  provider.add(A);
  provider.setSubtreeWeight(h('B'), 100);
  const module = new SamplingModule(provider, seededRandom([0.0]));
  module.addBlock(A.hash);

  const result = module.initSample(A.hash);
  assertEquals(result.terminal, false);
  if (!result.terminal) assertEquals(result.reason, 'missing');
});

Deno.test('Sampling: missing block increments queries but not verifications', () => {
  const A: TestBlock = {
    hash: h('A'),
    aggregates: [h('B')],
    selfWeight: 10,
    subtreeWeight: 110,
  };
  const provider = new TestProvider();
  provider.add(A);
  provider.setSubtreeWeight(h('B'), 100);
  const module = new SamplingModule(provider, seededRandom([0.0]));
  module.addBlock(A.hash);

  module.initSample(A.hash);
  assertEquals(module.getSampleState(A.hash)!.queries.length, 1);
  assertEquals(module.countVerifications(A.hash, 1), 0);
  assertEquals(module.getWeightFactor(A.hash), 0);
});

Deno.test('Sampling: weight factor recovers when missing block arrives and is verified', () => {
  const B = block('B', 90);
  const A: TestBlock = {
    hash: h('A'),
    aggregates: [B.hash],
    selfWeight: 10,
    subtreeWeight: 100,
  };

  const provider = new TestProvider();
  provider.add(A);
  provider.setSubtreeWeight(B.hash, 90);
  const module = new SamplingModule(provider, seededRandom([0.0]));
  module.addBlock(A.hash);

  // 2 probes hit missing B
  module.initSample(A.hash);
  module.initSample(A.hash);
  assertEquals(module.getWeightFactor(A.hash), 0);

  // B arrives
  provider.add(B);
  module.addBlock(B.hash);

  // Probe again -- B now reachable
  module.initSample(A.hash);
  module.recordVerification(B.hash, true);

  // 3 queries, 1 verified
  assertAlmostEquals(module.getWeightFactor(A.hash), 1 / 3);
});

// -- Priority (swing formula) ------------------------------------

Deno.test('Sampling: unknown tree (q=0) has priority I/6', () => {
  const { module } = setup([block('A', 100)]);
  assertAlmostEquals(module.getPriority(h('A')), 100 / 6);
});

Deno.test('Sampling: well-verified tree has low priority', () => {
  const { module } = setup([block('A', 100)], seededRandom([0.5]));
  for (let i = 0; i < 10; i++) {
    module.initSample(h('A'));
  }
  module.recordVerification(h('A'), true);
  // r=10, q=10
  assertAlmostEquals(module.getPriority(h('A')), swing(100, 10, 10));
});

Deno.test('Sampling: likely-fraud tree has low priority', () => {
  const { module } = setup([block('A', 100)], seededRandom([0.5]));
  for (let i = 0; i < 10; i++) module.initSample(h('A'));
  // r=0, q=10
  assertAlmostEquals(module.getPriority(h('A')), swing(100, 10, 0));
});

Deno.test('Sampling: maximum uncertainty (r ~ q/2) has highest priority for given q', () => {
  // Pure formula test
  const uncertain = swing(100, 10, 5);
  const verified = swing(100, 10, 10);
  const fraud = swing(100, 10, 0);

  assertEquals(uncertain > verified, true);
  assertEquals(uncertain > fraud, true);
  assertAlmostEquals(verified, fraud); // symmetric
});

Deno.test('Sampling: priority matches swing formula for concrete case', () => {
  // Use a leaf to get exact control over q and r
  const { module } = setup([block('A', 100)], seededRandom([0.5]));

  // 5 probes, then verify -> r=5, q=5
  for (let i = 0; i < 5; i++) module.initSample(h('A'));
  module.recordVerification(h('A'), true);

  const state = module.getSampleState(h('A'))!;
  const q = state.queries.length;
  const r = module.countVerifications(h('A'), q);
  assertEquals(q, 5);
  assertEquals(r, 5);

  assertAlmostEquals(module.getPriority(h('A')), swing(100, 5, 5));
});

Deno.test('Sampling: priority values from spec table', () => {
  // q=0, r=0: swing = I/6
  assertAlmostEquals(swing(100, 0, 0), 100 / 6);
  // q=1, r=1: swing = 2*100*2*1 / (9*4) = 400/36
  assertAlmostEquals(swing(100, 1, 1), 400 / 36);
  // q=10, r=10: swing = 2*100*11*1 / (144*13) = 2200/1872
  assertAlmostEquals(swing(100, 10, 10), 2200 / 1872);
  // q=10, r=0: swing = 2*100*1*11 / (144*13) = 2200/1872
  assertAlmostEquals(swing(100, 10, 0), 2200 / 1872);
});

Deno.test('Sampling: unknown tree has higher priority than well-probed tree', () => {
  const { module } = setup(
    [block('A', 100), block('B', 100)],
    seededRandom([0.5]),
  );

  for (let i = 0; i < 20; i++) {
    module.initSample(h('A'));
    module.recordVerification(h('A'), true);
  }

  assertEquals(module.getPriority(h('B')) > module.getPriority(h('A')), true);
});

// -- Expected canonicality change ---------------------------------

Deno.test('Sampling: conflict multiplier uses contested_weight / gap', () => {
  const { module } = setup([block('A', 100)]);
  const basePriority = module.getPriority(h('A'));

  // w_A = 100, w_rival = 80, gap = 5, contested = 180
  module.setConflictInfoSupplier(() => ({ weightGap: 5, contestedWeight: 180 }));

  const withConflict = module.getPriority(h('A'));
  assertAlmostEquals(withConflict, basePriority * 180 / 5);
});

Deno.test('Sampling: close contest with large trees gives very high priority', () => {
  const { module } = setup([block('A', 100), block('B', 100)]);

  module.setConflictInfoSupplier((hash) => {
    if (Hash.equals(hash, h('A'))) return { weightGap: 1, contestedWeight: 2000 };
    if (Hash.equals(hash, h('B'))) return { weightGap: 500, contestedWeight: 2000 };
    return undefined;
  });

  const pA = module.getPriority(h('A'));
  const pB = module.getPriority(h('B'));
  assertEquals(pA > pB, true, `close contest (${pA}) should be > distant (${pB})`);
  // A: swing * 2000/1 = swing * 2000
  // B: swing * 2000/500 = swing * 4
  assertAlmostEquals(pA / pB, 500);
});

Deno.test('Sampling: no conflict info leaves priority unchanged (just swing)', () => {
  const { module } = setup([block('A', 100)]);
  assertAlmostEquals(module.getPriority(h('A')), swing(100, 0, 0));
});

// -- Pending backpressure -----------------------------------------

Deno.test('Sampling: pending probes reduce priority', () => {
  const { module } = setup([block('A', 100)], seededRandom([0.5]));
  const priorities: number[] = [];
  priorities.push(module.getPriority(h('A')));

  for (let i = 0; i < 5; i++) {
    module.initSample(h('A'));
    priorities.push(module.getPriority(h('A')));
  }

  for (let i = 1; i < priorities.length; i++) {
    assertEquals(
      priorities[i] < priorities[i - 1],
      true,
      `priority[${i}]=${priorities[i]} should be < priority[${i - 1}]=${priorities[i - 1]}`,
    );
  }
});

Deno.test('Sampling: each additional pending probe further reduces priority', () => {
  const { module } = setup([block('A', 100)], seededRandom([0.5]));
  const prev = module.getPriority(h('A'));
  const reductions: number[] = [];

  for (let i = 0; i < 5; i++) {
    module.initSample(h('A'));
    const current = module.getPriority(h('A'));
    reductions.push(prev - current);
  }

  // All reductions are positive (priority strictly decreasing)
  for (const r of reductions) {
    assertEquals(r > 0, true);
  }
});

// -- Propagation boundary -----------------------------------------

Deno.test('Sampling: child independent probes do not leak to parent beyond limit', () => {
  const A = block('A', 100);
  const G = block('G', 0, [A]);
  const { module } = setup([G, A], seededRandom([0.5]));

  // Probe A independently 100 times
  for (let i = 0; i < 100; i++) {
    module.initSample(A.hash);
  }
  module.recordVerification(A.hash, true);

  // A has 100 verified queries
  assertEquals(module.countVerifications(A.hash, 100), 100);

  // G hasn't been probed -- weight factor still 0
  assertEquals(module.getWeightFactor(G.hash), 0);

  // Probe G twice
  module.initSample(G.hash);
  module.initSample(G.hash);

  // G sees only 2 of A's results
  assertEquals(module.countVerifications(G.hash, 2), 2);
  assertAlmostEquals(module.getWeightFactor(G.hash), 1.0);
});

Deno.test('Sampling: parent with 3 probes only sees 3 results from heavily-probed child', () => {
  const A = block('A', 100);
  const G = block('G', 0, [A]);
  const { module } = setup([G, A], seededRandom([0.5]));

  // Probe A 50 times independently
  for (let i = 0; i < 50; i++) module.initSample(A.hash);
  module.recordVerification(A.hash, true);

  // Probe G 3 times
  module.initSample(G.hash);
  module.initSample(G.hash);
  module.initSample(G.hash);

  assertEquals(module.countVerifications(G.hash, 3), 3);
});

// -- selectNext ---------------------------------------------------

Deno.test('Sampling: selectNext returns highest priority block', () => {
  const { module } = setup([block('A', 1000), block('B', 500), block('C', 200)]);
  assertEquals(Hash.equals(module.selectNext()!, h('A')), true);
});

Deno.test('Sampling: selectNext shifts after probing reduces priority', () => {
  const { module } = setup([block('A', 1000), block('B', 900)], seededRandom([0.5]));
  assertEquals(Hash.equals(module.selectNext()!, h('A')), true);

  for (let i = 0; i < 30; i++) {
    module.initSample(h('A'));
    module.recordVerification(h('A'), true);
  }
  assertEquals(Hash.equals(module.selectNext()!, h('B')), true);
});

Deno.test('Sampling: selectNext returns undefined when no blocks registered', () => {
  const module = new SamplingModule(new TestProvider());
  assertEquals(module.selectNext(), undefined);
});

// -- State management ---------------------------------------------

Deno.test('Sampling: getSampleState returns undefined for unknown block', () => {
  const module = new SamplingModule(new TestProvider());
  assertEquals(module.getSampleState(h('unknown')), undefined);
});

Deno.test('Sampling: addBlock creates initial probe state', () => {
  const A = block('A', 10, [block('B', 20), block('C', 30)]);
  const { module } = setup([A, block('B', 20), block('C', 30)]);
  const state = module.getSampleState(A.hash)!;
  assertEquals(state.queries.length, 0);
  assertEquals(state.selfVerified, false);
});

Deno.test('Sampling: removeBlock cleans up state', () => {
  const { module } = setup([block('A', 100)]);
  assertEquals(module.getSampleState(h('A')) !== undefined, true);
  module.removeBlock(h('A'));
  assertEquals(module.getSampleState(h('A')), undefined);
});

Deno.test('Sampling: recordVerification sets selfVerified to true on success', () => {
  const { module } = setup([block('A', 100)], seededRandom([0.5]));
  module.initSample(h('A'));
  assertEquals(module.getSampleState(h('A'))!.selfVerified, false);
  module.recordVerification(h('A'), true);
  assertEquals(module.getSampleState(h('A'))!.selfVerified, true);
});

Deno.test('Sampling: recordVerification with failure does not set selfVerified', () => {
  const { module } = setup([block('A', 100)], seededRandom([0.5]));
  module.initSample(h('A'));
  module.recordVerification(h('A'), false);
  assertEquals(module.getSampleState(h('A'))!.selfVerified, false);
});

Deno.test('Sampling: onWeightChange fires when verification recorded', () => {
  const { module } = setup([block('A', 100)], seededRandom([0.5]));
  const fired: Hash[] = [];
  module.onWeightChange((hash) => fired.push(hash));

  module.initSample(h('A'));
  module.recordVerification(h('A'), true);

  assertEquals(fired.length, 1);
  assertEquals(Hash.equals(fired[0], h('A')), true);
});

// -- Dynamic aggregate weights ------------------------------------

Deno.test('Sampling: aggregate weights update when blocks arrive later', () => {
  // G references A, but A arrives after G is registered
  const A = block('A', 50);
  const G: TestBlock = {
    hash: h('G'),
    aggregates: [A.hash],
    selfWeight: 10,
    subtreeWeight: 60,
  };

  const provider = new TestProvider();
  provider.add(G);
  // A not yet in provider -- weight returns 0
  const module = new SamplingModule(provider, seededRandom([0.0]));
  module.addBlock(G.hash);

  // G's total weight: selfWeight(10) + aggregateWeights([0]) = 10
  // All probes go to self since aggregate weight is 0
  module.initSample(G.hash);
  assertEquals(module.getSampleState(G.hash)!.queries[0], -1); // went to self

  // Now A arrives -- provider returns its weight
  provider.add(A);
  module.addBlock(A.hash);

  // Next probe on G now sees A's weight dynamically
  // Total: 10 + 50 = 60, random 0.0 -> 0.0 * 60 = 0 < 50 -> aggregate A
  module.initSample(G.hash);
  assertEquals(module.getSampleState(G.hash)!.queries[1], 0); // went to aggregate
});

// -- Convergence --------------------------------------------------

Deno.test('Sampling: fraud subtree converges weight factor toward correct value', () => {
  // Tree: G (self=10) -> A (self=5, sub=60) -> A1(15), A2(20,FRAUD)
  //                    -> B (self=8, sub=22) -> B1(22,FRAUD... no, just B)
  // Simpler: G has A (valid, weight 60) and B (fraud, weight 20), self=0
  // True weight factor should converge to 60/80 = 0.75
  const A = block('A', 60);
  const B = block('B', 20);
  const G = block('G', 0, [A, B]); // total 80

  const { module } = setup([G, A, B]);

  // Verify A (valid), don't verify B (fraud)
  module.recordVerification(A.hash, true);
  // B.selfVerified stays false

  // Run 2000 probes
  for (let i = 0; i < 2000; i++) {
    module.initSample(G.hash);
  }

  const wf = module.getWeightFactor(G.hash);
  // Should converge to 60/80 = 0.75 (+/-5%)
  assertEquals(wf > 0.70, true, `weight factor ${wf} should be > 0.70`);
  assertEquals(wf < 0.80, true, `weight factor ${wf} should be < 0.80`);
});

// -- SampleResult reason ------------------------------------------

Deno.test('Sampling: reused aggregate returns reason reused, not no_weight', () => {
  const A = block('A', 50);
  const G = block('G', 0, [A]);
  const { module } = setup([G, A], seededRandom([0.5]));

  // First probe descends to A (terminal)
  const r1 = module.initSample(G.hash);
  assertEquals(r1.terminal, true);

  // Second probe: A already has 1 query >= requested 1... wait, G now has 2 queries to A
  // requestedCount = 2, A has 1 query, so it will recurse again
  const r2 = module.initSample(G.hash);
  assertEquals(r2.terminal, true); // new terminal on A

  // Third probe: A now has 2 queries. requestedCount = 3 > 2, recurse again
  // Actually every G probe to A will recurse since requestedCount keeps growing.
  // To test reuse, we need to probe A independently first.

  // Probe A independently so it has extra queries
  module.initSample(A.hash);
  module.initSample(A.hash);
  // A now has 4 queries total (2 from G, 2 independent)

  // Next G probe: requestedCount=3, A.queries.length=4 (4 >= 3), so reuse
  const r3 = module.initSample(G.hash);
  assertEquals(r3.terminal, false);
  if (!r3.terminal) assertEquals(r3.reason, 'reused');
});
