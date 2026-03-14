import { assert, assertEquals } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { Block, BlockSource } from '../src/core/Block.ts';
import { FetchManager, FetchResult, Verifier } from '../src/node/FetchManager.ts';

// -- Test helpers ------------------------------------------------

function makeBlock(overrides?: Partial<Block>): Block {
  return {
    hash: Hash.random(),
    anchor: ZERO_HASH,
    aggregates: [],
    claims: [],
    outputs: [],
    declaredWeight: 1,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
    ...overrides,
  };
}

function makeVerifier(name?: string): Verifier {
  return {
    contractHash: Hash.digest(name ?? 'test-contract'),
    params: new TextEncoder().encode(name ?? 'test-params'),
  };
}

function makeResult(overrides?: Partial<FetchResult>): FetchResult {
  return {
    block: makeBlock(),
    data: new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

// -- Tests -------------------------------------------------------

Deno.test('FetchManager: basic fetch/notify roundtrip', () => {
  const fm = new FetchManager();
  const verifier = makeVerifier();
  const results: (FetchResult | null)[] = [];

  fm.fetch(verifier, {
    onResult: (r) => results.push(r),
  });

  const key = FetchManager.verifierKey(verifier);
  const result = makeResult();
  fm.notify(key, result);

  assertEquals(results.length, 1);
  assertEquals(results[0], result);
});

Deno.test('FetchManager: multiple subscriptions for same verifier get same notifications', () => {
  const fm = new FetchManager();
  const verifier = makeVerifier();
  const results1: (FetchResult | null)[] = [];
  const results2: (FetchResult | null)[] = [];

  fm.fetch(verifier, { onResult: (r) => results1.push(r) });
  fm.fetch(verifier, { onResult: (r) => results2.push(r) });

  const key = FetchManager.verifierKey(verifier);
  const result = makeResult();
  fm.notify(key, result);

  assertEquals(results1.length, 1);
  assertEquals(results1[0], result);
  assertEquals(results2.length, 1);
  assertEquals(results2[0], result);
});

Deno.test('FetchManager: FetchHandle.close() unsubscribes', () => {
  const fm = new FetchManager();
  const verifier = makeVerifier();
  const results: (FetchResult | null)[] = [];

  const handle = fm.fetch(verifier, {
    onResult: (r) => results.push(r),
  });

  const key = FetchManager.verifierKey(verifier);

  // Notify before close
  fm.notify(key, makeResult());
  assertEquals(results.length, 1);

  // Close and notify again
  handle.close();
  fm.notify(key, makeResult());
  assertEquals(results.length, 1, 'should not receive after close');
});

Deno.test('FetchManager: close removes verifier key when last subscription closes', () => {
  const fm = new FetchManager();
  const verifier = makeVerifier();

  const handle1 = fm.fetch(verifier, { onResult: () => {} });
  const handle2 = fm.fetch(verifier, { onResult: () => {} });
  const key = FetchManager.verifierKey(verifier);

  assert(fm.hasSubscription(key));

  handle1.close();
  assert(fm.hasSubscription(key), 'still has subscription after first close');

  handle2.close();
  assert(!fm.hasSubscription(key), 'no subscription after all closed');
});

Deno.test('FetchManager: close is idempotent', () => {
  const fm = new FetchManager();
  const verifier = makeVerifier();

  const handle = fm.fetch(verifier, { onResult: () => {} });
  const key = FetchManager.verifierKey(verifier);

  handle.close();
  handle.close(); // second close should be a no-op
  assert(!fm.hasSubscription(key));
});

Deno.test('FetchManager: hasSubscription tracks active subs', () => {
  const fm = new FetchManager();
  const verifier = makeVerifier();
  const key = FetchManager.verifierKey(verifier);

  assert(!fm.hasSubscription(key), 'no subscription initially');

  const handle = fm.fetch(verifier, { onResult: () => {} });
  assert(fm.hasSubscription(key), 'has subscription after fetch');

  handle.close();
  assert(!fm.hasSubscription(key), 'no subscription after close');
});

Deno.test('FetchManager: getActiveVerifierKeys returns all keys', () => {
  const fm = new FetchManager();
  const v1 = makeVerifier('contract-a');
  const v2 = makeVerifier('contract-b');

  assertEquals(fm.getActiveVerifierKeys().length, 0);

  fm.fetch(v1, { onResult: () => {} });
  const keys1 = fm.getActiveVerifierKeys();
  assertEquals(keys1.length, 1);
  assertEquals(keys1[0], FetchManager.verifierKey(v1));

  fm.fetch(v2, { onResult: () => {} });
  const keys2 = fm.getActiveVerifierKeys();
  assertEquals(keys2.length, 2);
  assert(keys2.includes(FetchManager.verifierKey(v1)));
  assert(keys2.includes(FetchManager.verifierKey(v2)));
});

Deno.test('FetchManager: notify with null (result lost canonicality)', () => {
  const fm = new FetchManager();
  const verifier = makeVerifier();
  const results: (FetchResult | null)[] = [];

  fm.fetch(verifier, { onResult: (r) => results.push(r) });

  const key = FetchManager.verifierKey(verifier);

  // First notify with a result
  fm.notify(key, makeResult());
  assertEquals(results.length, 1);
  assert(results[0] !== null);

  // Then notify with null (lost canonicality)
  fm.notify(key, null);
  assertEquals(results.length, 2);
  assertEquals(results[1], null);
});

Deno.test('FetchManager: notify with no subscriptions is a no-op', () => {
  const fm = new FetchManager();
  // Should not throw
  fm.notify('nonexistent-key', makeResult());
});

Deno.test('FetchManager: verifierKey generation is deterministic', () => {
  const contractHash = Hash.digest('my-contract');
  const params = new TextEncoder().encode('my-params');

  const v1: Verifier = { contractHash, params };
  const v2: Verifier = { contractHash, params };

  assertEquals(FetchManager.verifierKey(v1), FetchManager.verifierKey(v2));
});

Deno.test('FetchManager: verifierKey differs for different contracts', () => {
  const params = new Uint8Array([1, 2, 3]);
  const v1: Verifier = { contractHash: Hash.digest('contract-a'), params };
  const v2: Verifier = { contractHash: Hash.digest('contract-b'), params };

  assert(FetchManager.verifierKey(v1) !== FetchManager.verifierKey(v2));
});

Deno.test('FetchManager: verifierKey differs for different params', () => {
  const contractHash = Hash.digest('same-contract');
  const v1: Verifier = { contractHash, params: new Uint8Array([1]) };
  const v2: Verifier = { contractHash, params: new Uint8Array([2]) };

  assert(FetchManager.verifierKey(v1) !== FetchManager.verifierKey(v2));
});

Deno.test('FetchManager: verifierKey format is hex:hex', () => {
  const verifier = makeVerifier();
  const key = FetchManager.verifierKey(verifier);
  const parts = key.split(':');

  assertEquals(parts.length, 2);
  // Both parts should be hex strings
  assert(/^[0-9a-f]+$/.test(parts[0]), 'contract hash should be hex');
  assert(/^[0-9a-f]+$/.test(parts[1]), 'params should be hex');
});

Deno.test('FetchManager: different verifiers have independent subscriptions', () => {
  const fm = new FetchManager();
  const v1 = makeVerifier('contract-x');
  const v2 = makeVerifier('contract-y');
  const results1: (FetchResult | null)[] = [];
  const results2: (FetchResult | null)[] = [];

  fm.fetch(v1, { onResult: (r) => results1.push(r) });
  fm.fetch(v2, { onResult: (r) => results2.push(r) });

  const key1 = FetchManager.verifierKey(v1);
  fm.notify(key1, makeResult());

  assertEquals(results1.length, 1, 'v1 subscriber should be notified');
  assertEquals(results2.length, 0, 'v2 subscriber should not be notified');
});
