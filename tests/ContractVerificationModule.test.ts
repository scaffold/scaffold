import { assert, assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import type { Verifier } from '../src/core/BlockCreationModule.ts';
import type { ExecutionResult } from '../src/core/ContractHost.ts';
import {
  ContractVerificationModule,
  type ContractVerificationProvider,
} from '../src/core/ContractVerificationModule.ts';

// -- Test helpers --------------------------------------------------

function hashOf(hex: string): Hash {
  // Pad to a valid 32-byte hex; repeat to fill.
  const padded = hex.padEnd(64, '0').slice(0, 64);
  return Hash.fromHex(padded);
}

function verifier(contractHex: string, params: number[] = []): Verifier {
  return {
    contract: hashOf(contractHex),
    params: new Uint8Array(params),
  };
}

/**
 * Build a provider with controllable runVerification, enqueue, budget, priority.
 * `runResults` is a queue of results; each call shifts one.
 */
function makeProvider(opts: {
  runResults?: ExecutionResult[];
  budget?: number;
  priority?: number;
  enqueueRejects?: boolean;
} = {}): {
  provider: ContractVerificationProvider;
  runCalls: { block: Hash; verifier: Verifier }[];
  enqueueCalls: { priority: number; maxCostMs: number }[];
  resolveNext: () => void;
  pendingRuns: (() => void)[];
} {
  const runCalls: { block: Hash; verifier: Verifier }[] = [];
  const enqueueCalls: { priority: number; maxCostMs: number }[] = [];
  const results = [...(opts.runResults ?? [])];
  const pendingRuns: (() => void)[] = [];

  const provider: ContractVerificationProvider = {
    runVerification: (blockHash, v) => {
      runCalls.push({ block: blockHash, verifier: v });
      const result = results.shift() ?? { accepted: true as const };
      return new Promise<ExecutionResult>((res) => {
        pendingRuns.push(() => res(result));
      });
    },
    enqueue: (task) => {
      if (opts.enqueueRejects) return undefined;
      enqueueCalls.push({ priority: task.priority(), maxCostMs: task.maxCostMs });
      // Execute the task immediately; the queue normally runs it async but for
      // unit tests we synchronously kick it off and let the test control timing
      // by resolving pendingRuns.
      task.run().catch(() => {});
      return String(enqueueCalls.length);
    },
    budgetMs: () => opts.budget ?? 100,
    priority: () => opts.priority ?? 10,
  };

  return {
    provider,
    runCalls,
    enqueueCalls,
    resolveNext: () => pendingRuns.shift()?.(),
    pendingRuns,
  };
}

// -- Cache hit on repeat {block, verifier} -------------------------

Deno.test('ContractVerification: caches completed results; second call returns synchronously', async () => {
  const { provider, runCalls, resolveNext } = makeProvider({
    runResults: [{ accepted: true }],
  });
  const module = new ContractVerificationModule(provider);
  const block = hashOf('ab');
  const v = verifier('cd', [1, 2, 3]);

  const first = module.verify(block, v);
  resolveNext();
  assertEquals(await first, { accepted: true });
  assertEquals(runCalls.length, 1);

  // Second call: cache hit, no new run
  const second = await module.verify(block, v);
  assertEquals(second, { accepted: true });
  assertEquals(runCalls.length, 1);
});

// -- In-flight promise sharing ------------------------------------

Deno.test('ContractVerification: concurrent verify() calls share the in-flight promise', async () => {
  const { provider, runCalls, resolveNext } = makeProvider({
    runResults: [{ accepted: false, reason: 'nope' }],
  });
  const module = new ContractVerificationModule(provider);
  const block = hashOf('ab');
  const v = verifier('cd');

  const a = module.verify(block, v);
  const b = module.verify(block, v);
  const c = module.verify(block, v);
  // Only one run enqueued despite three verify() calls
  assertEquals(runCalls.length, 1);

  resolveNext();
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assertEquals(ra, rb);
  assertEquals(rb, rc);
  assertEquals(ra, { accepted: false, reason: 'nope' });
});

// -- Distinct {block, verifier} tuples do not collide --------------

Deno.test('ContractVerification: different verifier params produce independent runs', async () => {
  const { provider, runCalls, resolveNext } = makeProvider({
    runResults: [{ accepted: true }, { accepted: false, reason: 'different' }],
  });
  const module = new ContractVerificationModule(provider);
  const block = hashOf('ab');
  const v1 = verifier('cd', [1]);
  const v2 = verifier('cd', [2]);

  const a = module.verify(block, v1);
  const b = module.verify(block, v2);
  assertEquals(runCalls.length, 2);

  resolveNext();
  resolveNext();
  assertEquals(await a, { accepted: true });
  assertEquals(await b, { accepted: false, reason: 'different' });
});

Deno.test('ContractVerification: different blocks produce independent runs even with same verifier', async () => {
  const { provider, runCalls, resolveNext } = makeProvider({
    runResults: [{ accepted: true }, { accepted: false, reason: 'second' }],
  });
  const module = new ContractVerificationModule(provider);
  const v = verifier('cd');

  const a = module.verify(hashOf('11'), v);
  const b = module.verify(hashOf('22'), v);
  assertEquals(runCalls.length, 2);

  resolveNext();
  resolveNext();
  assertEquals(await a, { accepted: true });
  assertEquals(await b, { accepted: false, reason: 'second' });
});

// -- Budget rejection --------------------------------------------

Deno.test('ContractVerification: enqueue rejection resolves with declined result and caches it', async () => {
  const { provider, runCalls } = makeProvider({ enqueueRejects: true });
  const module = new ContractVerificationModule(provider);
  const block = hashOf('ab');
  const v = verifier('cd');

  const result = await module.verify(block, v);
  assertEquals(result, { accepted: false, reason: 'declined' });
  assertEquals(runCalls.length, 0);

  // Cached
  const second = await module.verify(block, v);
  assertEquals(second, { accepted: false, reason: 'declined' });
  assertEquals(runCalls.length, 0);
});

// -- Priority and budget callbacks --------------------------------

Deno.test('ContractVerification: enqueues with provider-supplied priority and budget', async () => {
  const { provider, enqueueCalls, resolveNext } = makeProvider({
    runResults: [{ accepted: true }],
    budget: 42,
    priority: 7,
  });
  const module = new ContractVerificationModule(provider);
  await (async () => {
    const p = module.verify(hashOf('ab'), verifier('cd'));
    resolveNext();
    await p;
  })();
  assertEquals(enqueueCalls.length, 1);
  assertEquals(enqueueCalls[0].maxCostMs, 42);
  assertEquals(enqueueCalls[0].priority, 7);
});

// -- getCached introspection --------------------------------------

Deno.test('ContractVerification: getCached returns undefined before and result after completion', async () => {
  const { provider, resolveNext } = makeProvider({
    runResults: [{ accepted: true }],
  });
  const module = new ContractVerificationModule(provider);
  const block = hashOf('ab');
  const v = verifier('cd');
  assertEquals(module.getCached(block, v), undefined);
  const p = module.verify(block, v);
  assertEquals(module.getCached(block, v), undefined); // still in-flight
  resolveNext();
  await p;
  assertEquals(module.getCached(block, v), { accepted: true });
});

// -- Run throws -> caches as failure ------------------------------

Deno.test('ContractVerification: provider runVerification throwing resolves as run-threw failure', async () => {
  const throwingProvider: ContractVerificationProvider = {
    runVerification: () => Promise.reject(new Error('boom')),
    enqueue: (task) => {
      // Fire task.run; await to observe rejection handling
      task.run().catch(() => {});
      return 'task-id';
    },
    budgetMs: () => 100,
    priority: () => 1,
  };
  const module = new ContractVerificationModule(throwingProvider);
  const result = await module.verify(hashOf('ab'), verifier('cd'));
  assert(!result.accepted);
  assert(result.reason.includes('run threw'));
});
