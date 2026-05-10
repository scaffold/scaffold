import { assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import type { Output, Verifier } from '../src/core/BlockCreationModule.ts';
import type { OutputSlot } from '../src/core/GeneratingEnv.ts';
import {
  NamespacePartitionModule,
  type OwnerContribution,
} from '../src/core/NamespacePartitionModule.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const hashOf = (s: string) => Hash.digest(s);

function out(contract: Hash, value: number, data = new Uint8Array(0)): Output {
  return {
    verifier: { contract, params: new Uint8Array(0) },
    value,
    data,
  };
}

function slot(output: Output, origin: 'require' | 'get' = 'require'): OutputSlot {
  return { output, origin };
}

function verifier(contract: Hash, params = new Uint8Array(0)): Verifier {
  return { contract, params };
}

Deno.test('partition: no owners, any outputs accepted', () => {
  const mod = new NamespacePartitionModule();
  const sig = hashOf('signature');
  const result = mod.check([out(sig, 42)], []);
  assertEquals(result.ok, true);
});

Deno.test('partition: two owners for same namespace rejects', () => {
  const mod = new NamespacePartitionModule();
  const sig = hashOf('signature');
  const c1 = hashOf('c1');
  const c2 = hashOf('c2');
  const result = mod.check([], [
    {
      runningVerifier: verifier(c1),
      declaredNamespaces: [sig],
      emittedSlots: [],
    },
    {
      runningVerifier: verifier(c2),
      declaredNamespaces: [sig],
      emittedSlots: [],
    },
  ]);
  assertEquals(result.ok, false);
});

Deno.test('partition: owner emitted sequence matches block outputs', () => {
  const mod = new NamespacePartitionModule();
  const sig = hashOf('signature');
  const c1 = hashOf('c1');

  const o1 = out(sig, 5);
  const o2 = out(sig, 3);
  const contrib: OwnerContribution = {
    runningVerifier: verifier(c1),
    declaredNamespaces: [sig],
    emittedSlots: [slot(o1), slot(o2)],
  };
  const result = mod.check([o1, o2], [contrib]);
  assertEquals(result.ok, true);
});

Deno.test('partition: positional value mismatch rejects (emitOutput)', () => {
  const mod = new NamespacePartitionModule();
  const sig = hashOf('signature');
  const c1 = hashOf('c1');

  const emitted = out(sig, 5);
  const onBlock = out(sig, 6);
  const contrib: OwnerContribution = {
    runningVerifier: verifier(c1),
    declaredNamespaces: [sig],
    emittedSlots: [slot(emitted, 'require')],
  };
  const result = mod.check([onBlock], [contrib]);
  assertEquals(result.ok, false);
});

Deno.test('partition: requestBody slot allows higher block value', () => {
  const mod = new NamespacePartitionModule();
  const sig = hashOf('signature');
  const c1 = hashOf('c1');

  const emitted = out(sig, 5);
  const onBlock = out(sig, 10);
  const contrib: OwnerContribution = {
    runningVerifier: verifier(c1),
    declaredNamespaces: [sig],
    emittedSlots: [slot(emitted, 'get')],
  };
  const result = mod.check([onBlock], [contrib]);
  assertEquals(result.ok, true);
});

Deno.test('partition: requestBody slot rejects lowered value', () => {
  const mod = new NamespacePartitionModule();
  const sig = hashOf('signature');
  const c1 = hashOf('c1');

  const emitted = out(sig, 5);
  const onBlock = out(sig, 3);
  const contrib: OwnerContribution = {
    runningVerifier: verifier(c1),
    declaredNamespaces: [sig],
    emittedSlots: [slot(emitted, 'get')],
  };
  const result = mod.check([onBlock], [contrib]);
  assertEquals(result.ok, false);
});

Deno.test('partition: unowned namespace outputs ignored by check', () => {
  const mod = new NamespacePartitionModule();
  const sig = hashOf('signature');
  const agg = hashOf('aggregation');
  const c1 = hashOf('c1');

  // Contract owns SIGNATURE. AGGREGATION marker is unowned (no claim
  // declares it) -- partition check should pass.
  const emitted = out(sig, 5);
  const contrib: OwnerContribution = {
    runningVerifier: verifier(c1),
    declaredNamespaces: [sig],
    emittedSlots: [slot(emitted)],
  };
  const result = mod.check(
    [emitted, {
      verifier: { contract: agg, params: new Uint8Array(0) },
      value: 0,
      data: new Uint8Array(0),
    }],
    [contrib],
  );
  assertEquals(result.ok, true);
});

Deno.test('partition: data mismatch rejects', () => {
  const mod = new NamespacePartitionModule();
  const sig = hashOf('signature');
  const c1 = hashOf('c1');

  const emitted = out(sig, 5, enc('expected'));
  const onBlock = out(sig, 5, enc('actual'));
  const contrib: OwnerContribution = {
    runningVerifier: verifier(c1),
    declaredNamespaces: [sig],
    emittedSlots: [slot(emitted)],
  };
  const result = mod.check([onBlock], [contrib]);
  assertEquals(result.ok, false);
});

Deno.test('partition: block output count exceeds emitted rejects', () => {
  const mod = new NamespacePartitionModule();
  const sig = hashOf('signature');
  const c1 = hashOf('c1');

  const emitted = out(sig, 5);
  const extra = out(sig, 7);
  const contrib: OwnerContribution = {
    runningVerifier: verifier(c1),
    declaredNamespaces: [sig],
    emittedSlots: [slot(emitted)],
  };
  const result = mod.check([emitted, extra], [contrib]);
  assertEquals(result.ok, false);
});

Deno.test('partition: data-less output in unowned namespace accepted', () => {
  const mod = new NamespacePartitionModule();
  const sig = hashOf('signature');
  const incentive = hashOf('incentive');
  const c1 = hashOf('c1');

  // Contract owns SIGNATURE. An INCENTIVE namespace output with no data
  // is unowned (no claim declares it) -- partition check should pass.
  const emitted = out(sig, 5);
  const nullIncentive: Output = {
    verifier: { contract: incentive, params: new Uint8Array(0) },
    value: 100,
  };
  const contrib: OwnerContribution = {
    runningVerifier: verifier(c1),
    declaredNamespaces: [sig],
    emittedSlots: [slot(emitted)],
  };
  const result = mod.check([emitted, nullIncentive], [contrib]);
  assertEquals(result.ok, true);
});

Deno.test('partition: data-less output in owned namespace rejected', () => {
  const mod = new NamespacePartitionModule();
  const sig = hashOf('signature');
  const c1 = hashOf('c1');

  // Contract owns SIGNATURE and emits a normal slot, but the block also
  // has a data-less output in the same namespace -- contracts cannot
  // emit data-less outputs, so this is a protocol violation.
  const emitted = out(sig, 5, enc('payload'));
  const nullInOwned: Output = {
    verifier: { contract: sig, params: new Uint8Array(0) },
    value: 0,
  };
  const contrib: OwnerContribution = {
    runningVerifier: verifier(c1),
    declaredNamespaces: [sig],
    emittedSlots: [slot(emitted)],
  };
  // Two block outputs in the owned namespace but only one emitted --
  // this will fail on count mismatch. Adjust emitted to match:
  const contrib2: OwnerContribution = {
    runningVerifier: verifier(c1),
    declaredNamespaces: [sig],
    emittedSlots: [slot(nullInOwned), slot(emitted)],
  };
  const result = mod.check([nullInOwned, emitted], [contrib2]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    // Should mention data-less.
    assertEquals(result.reason.includes('data-less'), true);
  }
});
