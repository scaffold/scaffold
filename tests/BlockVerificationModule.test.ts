import { assert, assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import type { Verifier } from '../src/core/BlockCreationModule.ts';
import type { ExecutionResult } from '../src/core/ContractHost.ts';
import {
  BlockVerificationModule,
  type BlockVerificationProvider,
} from '../src/core/BlockVerificationModule.ts';

// -- Helpers -------------------------------------------------------

function hashOf(hex: string): Hash {
  return Hash.fromHex(hex.padEnd(64, '0').slice(0, 64));
}

function verifier(contractHex: string, params: number[] = []): Verifier {
  return { contract: hashOf(contractHex), params: new Uint8Array(params) };
}

interface MockWorld {
  provider: BlockVerificationProvider;
  claimCounts: Map<string, number>;
  verifiers: Map<string, Verifier>;
  verifyResults: Map<string, ExecutionResult>;
  verifyCalls: { block: Hash; verifier: Verifier }[];
  fireResolution: (claimant: Hash, target: { block: Hash; outputIndex: number }) => void;
}

function makeWorld(): MockWorld {
  const claimCounts = new Map<string, number>();
  const verifiers = new Map<string, Verifier>();
  const verifyResults = new Map<string, ExecutionResult>();
  const verifyCalls: { block: Hash; verifier: Verifier }[] = [];
  const listeners: ((
    claimant: Hash,
    target: { block: Hash; outputIndex: number },
  ) => void)[] = [];

  const provider: BlockVerificationProvider = {
    getClaimCount: (h) => claimCounts.get(h.toPrimitive()),
    getVerifier: (b, i) => verifiers.get(`${b.toPrimitive()}:${i}`),
    onResolution: (cb) => listeners.push(cb),
    verifyContract: async (block, v) => {
      verifyCalls.push({ block, verifier: v });
      const key = `${block.toPrimitive()}:${v.contract.toPrimitive()}:${Array.from(v.params).join(',')}`;
      return verifyResults.get(key) ?? { accepted: true };
    },
  };

  return {
    provider,
    claimCounts,
    verifiers,
    verifyResults,
    verifyCalls,
    fireResolution: (claimant, target) => {
      for (const cb of listeners) cb(claimant, target);
    },
  };
}

function verifyKey(block: Hash, v: Verifier): string {
  return `${block.toPrimitive()}:${v.contract.toPrimitive()}:${Array.from(v.params).join(',')}`;
}

function outputKey(block: Hash, index: number): string {
  return `${block.toPrimitive()}:${index}`;
}

// -- Tests ---------------------------------------------------------

Deno.test('BlockVerification: empty-claims block resolves true immediately', async () => {
  const w = makeWorld();
  const block = hashOf('ab');
  w.claimCounts.set(block.toPrimitive(), 0);

  const module = new BlockVerificationModule(w.provider);
  assertEquals((await module.verify(block)).accepted, true);
  assertEquals(w.verifyCalls.length, 0);
});

Deno.test('BlockVerification: all claims accept -> true', async () => {
  const w = makeWorld();
  const block = hashOf('ab');
  const targetA = hashOf('11');
  const targetB = hashOf('22');
  w.claimCounts.set(block.toPrimitive(), 2);
  w.verifiers.set(outputKey(targetA, 0), verifier('aa', [1]));
  w.verifiers.set(outputKey(targetB, 0), verifier('bb', [2]));

  const module = new BlockVerificationModule(w.provider);

  // Resolutions come before the verify() call -- module has already cached them.
  w.fireResolution(block, { block: targetA, outputIndex: 0 });
  w.fireResolution(block, { block: targetB, outputIndex: 0 });

  assertEquals((await module.verify(block)).accepted, true);
  assertEquals(w.verifyCalls.length, 2);
});

Deno.test('BlockVerification: fail-fast on first reject', async () => {
  const w = makeWorld();
  const block = hashOf('ab');
  const targetA = hashOf('11');
  const targetB = hashOf('22');
  w.claimCounts.set(block.toPrimitive(), 2);
  const vA = verifier('aa', [1]);
  const vB = verifier('bb', [2]);
  w.verifiers.set(outputKey(targetA, 0), vA);
  w.verifiers.set(outputKey(targetB, 0), vB);

  // First verifier rejects, second would accept. Fail-fast returns false after first.
  w.verifyResults.set(verifyKey(block, vA), { accepted: false, reason: 'bad' });

  const module = new BlockVerificationModule(w.provider);
  w.fireResolution(block, { block: targetA, outputIndex: 0 });
  w.fireResolution(block, { block: targetB, outputIndex: 0 });

  assertEquals((await module.verify(block)).accepted, false);
  // Note: we still dispatch both (no cancellation today). Fail-fast is on the aggregate
  // result, not on in-flight tasks.
  assertEquals(w.verifyCalls.length, 2);
});

Deno.test('BlockVerification: deferred on unresolved claims; resumes when resolutions arrive', async () => {
  const w = makeWorld();
  const block = hashOf('ab');
  const targetA = hashOf('11');
  w.claimCounts.set(block.toPrimitive(), 2);
  w.verifiers.set(outputKey(targetA, 0), verifier('aa'));
  const targetB = hashOf('22');
  w.verifiers.set(outputKey(targetB, 0), verifier('bb'));

  const module = new BlockVerificationModule(w.provider);

  // Fire the first resolution immediately; second claim still unknown.
  w.fireResolution(block, { block: targetA, outputIndex: 0 });

  let settled = false;
  const promise = module.verify(block).then((r) => {
    settled = true;
    return r;
  });

  // Yield to the event loop; verify() should be pending.
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(settled, false);
  assertEquals(w.verifyCalls.length, 0);

  // Second resolution arrives.
  w.fireResolution(block, { block: targetB, outputIndex: 0 });

  assertEquals((await promise).accepted, true);
  assertEquals(w.verifyCalls.length, 2);
});

Deno.test('BlockVerification: concurrent verify() calls share the in-flight promise', async () => {
  const w = makeWorld();
  const block = hashOf('ab');
  const targetA = hashOf('11');
  w.claimCounts.set(block.toPrimitive(), 1);
  w.verifiers.set(outputKey(targetA, 0), verifier('aa'));

  const module = new BlockVerificationModule(w.provider);
  w.fireResolution(block, { block: targetA, outputIndex: 0 });

  const a = module.verify(block);
  const b = module.verify(block);
  // They must be the same promise instance.
  assert(a === b, 'concurrent verify() should share one promise');
  assertEquals((await a).accepted, true);
  assertEquals((await b).accepted, true);
  assertEquals(w.verifyCalls.length, 1);
});

Deno.test('BlockVerification: unknown target verifier rejects', async () => {
  const w = makeWorld();
  const block = hashOf('ab');
  const target = hashOf('11');
  w.claimCounts.set(block.toPrimitive(), 1);
  // Note: no verifier registered for target output.

  const module = new BlockVerificationModule(w.provider);
  w.fireResolution(block, { block: target, outputIndex: 0 });

  assertEquals((await module.verify(block)).accepted, false);
  assertEquals(w.verifyCalls.length, 0);
});

Deno.test('BlockVerification: resolutions accumulated before verify() call are used', async () => {
  const w = makeWorld();
  const block = hashOf('ab');
  const target = hashOf('11');
  w.verifiers.set(outputKey(target, 0), verifier('aa'));

  const module = new BlockVerificationModule(w.provider);
  // Resolution fires before we even know claim count.
  w.fireResolution(block, { block: target, outputIndex: 0 });

  // Now the block arrives with claim count.
  w.claimCounts.set(block.toPrimitive(), 1);
  assertEquals((await module.verify(block)).accepted, true);
  assertEquals(w.verifyCalls.length, 1);
});

Deno.test('BlockVerification: duplicate resolutions are deduplicated', async () => {
  const w = makeWorld();
  const block = hashOf('ab');
  const target = hashOf('11');
  w.claimCounts.set(block.toPrimitive(), 2);
  w.verifiers.set(outputKey(target, 0), verifier('aa'));
  const targetB = hashOf('22');
  w.verifiers.set(outputKey(targetB, 0), verifier('bb'));

  const module = new BlockVerificationModule(w.provider);

  // Fire same resolution twice; only one claim is actually resolved.
  w.fireResolution(block, { block: target, outputIndex: 0 });
  w.fireResolution(block, { block: target, outputIndex: 0 });

  let settled = false;
  const promise = module.verify(block).then((r) => {
    settled = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(settled, false, 'duplicate should not unblock second claim');

  w.fireResolution(block, { block: targetB, outputIndex: 0 });
  assertEquals((await promise).accepted, true);
});

Deno.test('BlockVerification: getStatus reports unknown / verifying / passed / failed', async () => {
  const w = makeWorld();
  const block = hashOf('ab');
  const target = hashOf('11');
  w.claimCounts.set(block.toPrimitive(), 1);
  w.verifiers.set(outputKey(target, 0), verifier('aa'));

  const module = new BlockVerificationModule(w.provider);

  // Before anything: unknown.
  assertEquals(module.getStatus(block), 'unknown');

  // In-flight: verifying (claim not resolved yet).
  const p = module.verify(block);
  assertEquals(module.getStatus(block), 'verifying');

  // Settles -> passed.
  w.fireResolution(block, { block: target, outputIndex: 0 });
  await p;
  assertEquals(module.getStatus(block), 'passed');

  // Failed case on a different block.
  const block2 = hashOf('cd');
  const target2 = hashOf('22');
  const v2 = verifier('bb');
  w.claimCounts.set(block2.toPrimitive(), 1);
  w.verifiers.set(outputKey(target2, 0), v2);
  w.verifyResults.set(verifyKey(block2, v2), { accepted: false, reason: 'bad' });

  w.fireResolution(block2, { block: target2, outputIndex: 0 });
  await module.verify(block2);
  assertEquals(module.getStatus(block2), 'failed');
});

Deno.test('BlockVerification: getStatus unknown stays unknown for unqueried blocks', () => {
  const w = makeWorld();
  const module = new BlockVerificationModule(w.provider);
  assertEquals(module.getStatus(hashOf('feed')), 'unknown');
});
