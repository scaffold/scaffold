import { assertEquals, assertAlmostEquals } from '@std/assert';
import { Hash, HashPrimitive } from '../src/util/Hash.ts';
import {
  SamplingModule,
  SamplingProvider,
  WorkDistribution,
} from '../src/core/SamplingModule.ts';

// -- Test helpers ------------------------------------------------

interface TestTree {
  hash: Hash;
  declaredWork: number;
  descendantWeight: number;
}

class TestProvider implements SamplingProvider<TestTree> {
  private trees = new Map<HashPrimitive, TestTree>();

  add(tree: TestTree): void {
    this.trees.set(tree.hash.toPrimitive(), tree);
  }

  setDescendantWeight(hash: Hash, weight: number): void {
    const tree = this.trees.get(hash.toPrimitive());
    if (tree) tree.descendantWeight = weight;
  }

  getBlock(hash: Hash): TestTree | undefined {
    return this.trees.get(hash.toPrimitive());
  }

  getDeclaredWork(block: TestTree): number {
    return block.declaredWork;
  }

  getDescendantWeight(block: TestTree): number {
    return block.descendantWeight;
  }
}

const h = (name: string): Hash => Hash.digest(name);

function setup(...trees: TestTree[]): {
  provider: TestProvider;
  module: SamplingModule<TestTree>;
} {
  const provider = new TestProvider();
  const module = new SamplingModule(provider);
  for (const tree of trees) {
    provider.add(tree);
    module.addTree(tree.hash);
  }
  return { provider, module };
}

function tree(name: string, declaredWork: number, descendantWeight = 0): TestTree {
  return { hash: h(name), declaredWork, descendantWeight };
}

// -- Tests -------------------------------------------------------

// Distribution tests

Deno.test('unsampled tree has zero verified work', () => {
  const { module } = setup(tree('A', 1000));
  assertEquals(module.getVerifiedWork(h('A')), 0);
});

Deno.test('unsampled tree distribution has n=0, f=0, mean=0', () => {
  const { module } = setup(tree('A', 1000));
  const dist = module.getDistribution(h('A'))!;
  assertEquals(dist.successes, 0);
  assertEquals(dist.failures, 0);
  assertEquals(dist.mean, 0);
});

Deno.test('one success gives mean = 1/2', () => {
  const { module } = setup(tree('A', 1000));
  module.recordSampleRequested(h('A'));
  module.recordSampleSuccess(h('A'));
  const dist = module.getDistribution(h('A'))!;
  assertEquals(dist.successes, 1);
  assertEquals(dist.failures, 0);
  assertAlmostEquals(dist.mean, 1 / 2);
});

Deno.test('verified work after one success is W/2', () => {
  const { module } = setup(tree('A', 1000));
  module.recordSampleRequested(h('A'));
  module.recordSampleSuccess(h('A'));
  assertAlmostEquals(module.getVerifiedWork(h('A')), 500);
});

Deno.test('five successes zero failures gives mean = 5/6', () => {
  const { module } = setup(tree('A', 600));
  for (let i = 0; i < 5; i++) {
    module.recordSampleRequested(h('A'));
    module.recordSampleSuccess(h('A'));
  }
  const dist = module.getDistribution(h('A'))!;
  assertEquals(dist.successes, 5);
  assertEquals(dist.failures, 0);
  assertAlmostEquals(dist.mean, 5 / 6);
  assertAlmostEquals(module.getVerifiedWork(h('A')), 500);
});

Deno.test('all failures gives zero verified work', () => {
  const { module } = setup(tree('A', 1000));
  for (let i = 0; i < 5; i++) {
    module.recordSampleRequested(h('A'));
    module.recordSampleFailure(h('A'));
  }
  assertEquals(module.getVerifiedWork(h('A')), 0);
  assertEquals(module.getDistribution(h('A'))!.mean, 0);
});

Deno.test('three successes two failures gives mean = 3/6 = 0.5', () => {
  const { module } = setup(tree('A', 1000));
  for (let i = 0; i < 3; i++) {
    module.recordSampleRequested(h('A'));
    module.recordSampleSuccess(h('A'));
  }
  for (let i = 0; i < 2; i++) {
    module.recordSampleRequested(h('A'));
    module.recordSampleFailure(h('A'));
  }
  assertAlmostEquals(module.getDistribution(h('A'))!.mean, 3 / 6);
  assertAlmostEquals(module.getVerifiedWork(h('A')), 500);
});

// Pending-as-failure tests

Deno.test('pending sample counts as failure in distribution', () => {
  const { module } = setup(tree('A', 1000));
  module.recordSampleRequested(h('A'));
  // Not resolved yet — should count as failure
  const dist = module.getDistribution(h('A'))!;
  assertEquals(dist.successes, 0);
  assertEquals(dist.failures, 1);
  assertEquals(dist.mean, 0);
});

Deno.test('resolving pending as success flips f to n', () => {
  const { module } = setup(tree('A', 1000));
  module.recordSampleRequested(h('A'));
  // Before resolution: n=0, f=1
  assertEquals(module.getDistribution(h('A'))!.failures, 1);
  // Resolve as success
  module.recordSampleSuccess(h('A'));
  const dist = module.getDistribution(h('A'))!;
  assertEquals(dist.successes, 1);
  assertEquals(dist.failures, 0);
  assertAlmostEquals(dist.mean, 1 / 2);
});

Deno.test('resolving pending as failure is a no-op on state', () => {
  const { module } = setup(tree('A', 1000));
  module.recordSampleRequested(h('A'));
  const before = module.getDistribution(h('A'))!;
  module.recordSampleFailure(h('A'));
  const after = module.getDistribution(h('A'))!;
  assertEquals(before.successes, after.successes);
  assertEquals(before.failures, after.failures);
});

// Priority tests

Deno.test('unseen tree priority is W/6 (with D=0)', () => {
  const { module } = setup(tree('A', 1200));
  // priority = 2W(n+1)(f+1)/[(s+2)^2(s+3)] * W/(W+D)
  // = 2*1200*1*1 / (4*3) * 1200/1200 = 2400/12 = 200
  assertAlmostEquals(module.getPriority(h('A')), 200);
});

Deno.test('priority decreases with more samples (less uncertainty)', () => {
  const { module } = setup(tree('A', 1000));
  const p0 = module.getPriority(h('A'));
  for (let i = 0; i < 5; i++) {
    module.recordSampleRequested(h('A'));
    module.recordSampleSuccess(h('A'));
  }
  const p1 = module.getPriority(h('A'));
  assertEquals(p1 < p0, true);
});

Deno.test('priority decreases with descendant weight', () => {
  const tA = tree('A', 1000, 0);
  const tB = tree('B', 1000, 5000);
  const { module } = setup(tA, tB);
  const pA = module.getPriority(h('A'));
  const pB = module.getPriority(h('B'));
  assertEquals(pB < pA, true);
});

Deno.test('pending samples reduce priority (inflated f)', () => {
  const { module } = setup(tree('A', 1000));
  const p0 = module.getPriority(h('A'));
  // Request 3 samples without resolving
  for (let i = 0; i < 3; i++) {
    module.recordSampleRequested(h('A'));
  }
  const p1 = module.getPriority(h('A'));
  assertEquals(p1 < p0, true);
});

Deno.test('priority matches formula for concrete case', () => {
  // n=3, f=2, s=5, W=1000, D=0
  const { module } = setup(tree('A', 1000));
  for (let i = 0; i < 3; i++) {
    module.recordSampleRequested(h('A'));
    module.recordSampleSuccess(h('A'));
  }
  for (let i = 0; i < 2; i++) {
    module.recordSampleRequested(h('A'));
    module.recordSampleFailure(h('A'));
  }
  // priority = 2*1000*4*3 / (49*8) * 1000/1000 = 24000/392
  assertAlmostEquals(module.getPriority(h('A')), 24000 / 392);
});

Deno.test('priority with descendant weight matches formula', () => {
  // n=0, f=0, W=200, D=5000
  const { module } = setup(tree('C', 200, 5000));
  // priority = 2*200*1*1 / (4*3) * 200/5200 = 400/12 * 200/5200
  assertAlmostEquals(module.getPriority(h('C')), (400 / 12) * (200 / 5200));
});

Deno.test('fraud deprioritization: many failures reduce priority', () => {
  const { module } = setup(tree('A', 1000));
  const priorities: number[] = [];
  priorities.push(module.getPriority(h('A')));
  for (let i = 0; i < 10; i++) {
    module.recordSampleRequested(h('A'));
    module.recordSampleFailure(h('A'));
    priorities.push(module.getPriority(h('A')));
  }
  // Each successive priority should be lower
  for (let i = 1; i < priorities.length; i++) {
    assertEquals(priorities[i] < priorities[i - 1], true);
  }
});

// selectNext tests

Deno.test('selectNext returns highest priority tree', () => {
  const { module } = setup(
    tree('A', 1000),
    tree('B', 500),
    tree('C', 200),
  );
  const next = module.selectNext()!;
  assertEquals(Hash.equals(next, h('A')), true);
});

Deno.test('selectNext shifts after sampling reduces priority', () => {
  const { module } = setup(
    tree('A', 1000),
    tree('B', 900),
  );
  // A has higher priority initially
  assertEquals(Hash.equals(module.selectNext()!, h('A')), true);
  // Sample A many times to reduce its priority
  for (let i = 0; i < 20; i++) {
    module.recordSampleRequested(h('A'));
    module.recordSampleSuccess(h('A'));
  }
  // Now B should have higher priority
  assertEquals(Hash.equals(module.selectNext()!, h('B')), true);
});

Deno.test('selectNext returns undefined when no trees registered', () => {
  const provider = new TestProvider();
  const module = new SamplingModule(provider);
  assertEquals(module.selectNext(), undefined);
});

Deno.test('descendant weight update changes priority dynamically', () => {
  const { provider, module } = setup(tree('A', 1000, 0));
  const p0 = module.getPriority(h('A'));
  provider.setDescendantWeight(h('A'), 10000);
  const p1 = module.getPriority(h('A'));
  assertEquals(p1 < p0, true);
});

// getState tests

Deno.test('getState returns full snapshot', () => {
  const { module } = setup(tree('A', 1000));
  module.recordSampleRequested(h('A'));
  module.recordSampleSuccess(h('A'));
  const state = module.getState(h('A'))!;
  assertEquals(state.declaredWork, 1000);
  assertEquals(state.distribution.successes, 1);
  assertEquals(state.distribution.failures, 0);
  assertAlmostEquals(state.verifiedWork, 500);
  assertEquals(state.priority > 0, true);
});

Deno.test('getState returns undefined for unknown tree', () => {
  const provider = new TestProvider();
  const module = new SamplingModule(provider);
  assertEquals(module.getState(h('unknown')), undefined);
});

Deno.test('getDistribution returns undefined for unknown tree', () => {
  const provider = new TestProvider();
  const module = new SamplingModule(provider);
  assertEquals(module.getDistribution(h('unknown')), undefined);
});
