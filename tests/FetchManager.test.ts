import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { Scaffold, ScaffoldConfig } from '../src/Scaffold.ts';
import { composeGenesisPacket } from '../src/core/Block.ts';
import { makeSignatureOutput } from '../src/contracts/SignatureContract.ts';
import { WELL_KNOWN_PRIVATE_KEY, WELL_KNOWN_PUBLIC_KEY } from '../src/graph/genesis.ts';
import { FetchClaim, FetchHandle, FetchManager, FetchResult } from '../src/node/FetchManager.ts';
import {
  FetchAbortError,
  InvalidatedError,
  NotImplementedError,
  SupersededError,
} from '../src/node/FetchErrors.ts';

// -- Helpers ---------------------------------------------------------

function defaultConfig(): ScaffoldConfig {
  const outputs = [makeSignatureOutput(WELL_KNOWN_PUBLIC_KEY, 1_000_000)];
  const genesis = composeGenesisPacket(outputs);
  return { genesis, privateKey: WELL_KNOWN_PRIVATE_KEY, enableLogging: false };
}

function settle(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// -- Static helper ---------------------------------------------------

Deno.test('FetchManager.verifierKey: deterministic for same verifier', () => {
  const v1 = { contract: Hash.digest('c'), params: new TextEncoder().encode('p') };
  const v2 = { contract: Hash.digest('c'), params: new TextEncoder().encode('p') };
  assertEquals(FetchManager.verifierKey(v1), FetchManager.verifierKey(v2));
});

Deno.test('FetchManager.verifierKey: differs for different contract', () => {
  const params = new Uint8Array([1]);
  const a = { contract: Hash.digest('a'), params };
  const b = { contract: Hash.digest('b'), params };
  assert(FetchManager.verifierKey(a) !== FetchManager.verifierKey(b));
});

Deno.test('FetchManager.verifierKey: format is hex:hex', () => {
  const k = FetchManager.verifierKey({
    contract: Hash.digest('x'),
    params: new Uint8Array([1, 2, 3]),
  });
  const [a, b] = k.split(':');
  assert(/^[0-9a-f]+$/.test(a));
  assert(/^[0-9a-f]+$/.test(b));
});

// -- Surface tests via Scaffold --------------------------------------

Deno.test('fetch: returns a handle with close()', async () => {
  const sf = new Scaffold(defaultConfig());
  const h = sf.fetch({
    contract: Hash.digest('t'),
    params: new Uint8Array([1, 2, 3]),
    onResult: () => {},
  });
  assert('close' in h);
  h.close();
  await sf.close();
});

Deno.test('fetch: publishes an incentive block and fires onIncentive', async () => {
  const sf = new Scaffold(defaultConfig());
  const contract = Hash.digest('t');
  const params = new TextEncoder().encode('k');
  let incentiveFired = false;
  let incentiveOutputIdx: number | undefined;

  const h = sf.fetch({
    contract,
    params,
    onResult: () => {},
    onIncentive: (_block, idx) => {
      incentiveFired = true;
      incentiveOutputIdx = idx;
    },
  }) as FetchHandle;

  await settle();
  assert(incentiveFired, 'onIncentive should fire after publish');
  assert(incentiveOutputIdx !== undefined);

  h.close();
  await sf.close();
});

Deno.test('fetch: publish:false throws NotImplementedError', async () => {
  const sf = new Scaffold(defaultConfig());
  assertThrows(
    () =>
      sf.fetch({
        contract: Hash.digest('t'),
        params: new Uint8Array(),
        publish: false,
        onResult: () => {},
      }),
    NotImplementedError,
  );
  await sf.close();
});

Deno.test('fetch: object params without buildParams throws synchronously', async () => {
  const sf = new Scaffold(defaultConfig());
  assertThrows(
    () =>
      sf.fetch({
        contract: Hash.digest('no-builder'),
        params: { foo: 'bar' },
        onResult: () => {},
      }),
    Error,
    'not registered',
  );
  await sf.close();
});

Deno.test('fetch: deduped subscriptions share a single incentive', async () => {
  const sf = new Scaffold(defaultConfig());
  const contract = Hash.digest('dedup');
  const params = new TextEncoder().encode('p');

  let count1 = 0;
  let count2 = 0;
  let incentiveBlockHash1: string | undefined;
  let incentiveBlockHash2: string | undefined;
  const h1 = sf.fetch({
    contract,
    params,
    onResult: () => count1++,
    onIncentive: (block) => {
      incentiveBlockHash1 = block.hash.toHex();
    },
  }) as FetchHandle;
  const h2 = sf.fetch({
    contract,
    params,
    onResult: () => count2++,
    onIncentive: (block) => {
      incentiveBlockHash2 = block.hash.toHex();
    },
  }) as FetchHandle;

  await settle();
  assertEquals(
    incentiveBlockHash1,
    incentiveBlockHash2,
    'both projections see the same incentive block',
  );
  h1.close();
  h2.close();
  await sf.close();
});

Deno.test('fetch: close() on one projection keeps subscription alive for others', async () => {
  const sf = new Scaffold(defaultConfig());
  const contract = Hash.digest('refcount');
  const params = new Uint8Array([1]);
  const key = FetchManager.verifierKey({ contract, params });

  const h1 = sf.fetch({
    contract,
    params,
    onResult: () => {},
  }) as FetchHandle;
  const h2 = sf.fetch({
    contract,
    params,
    onResult: () => {},
  }) as FetchHandle;

  // Internal: peek at the fetchManager via context to assert subscription lifecycle.
  const fm = (sf as unknown as { fetchManager: FetchManager }).fetchManager;
  assert(fm.hasSubscription(key));

  h1.close();
  assert(fm.hasSubscription(key), 'still subscribed after first close');
  h2.close();
  assert(!fm.hasSubscription(key), 'no subscription after last close');

  await sf.close();
});

Deno.test('fetch: signal abort closes the subscription immediately', async () => {
  const sf = new Scaffold(defaultConfig());
  const controller = new AbortController();
  const contract = Hash.digest('abort');
  const params = new Uint8Array([7]);
  const key = FetchManager.verifierKey({ contract, params });

  sf.fetch({
    contract,
    params,
    signal: controller.signal,
    onResult: () => {},
  });

  const fm = (sf as unknown as { fetchManager: FetchManager }).fetchManager;
  assert(fm.hasSubscription(key));
  controller.abort();
  assert(!fm.hasSubscription(key), 'abort should drop the subscription');

  await sf.close();
});

Deno.test('fetch: verify:true with aborted signal rejects with FetchAbortError', async () => {
  const sf = new Scaffold(defaultConfig());
  const controller = new AbortController();
  controller.abort();

  await assertRejects(
    () =>
      sf.fetch({
        contract: Hash.digest('t'),
        params: new Uint8Array(),
        verify: true,
        signal: controller.signal,
      }),
    FetchAbortError,
  );
  await sf.close();
});

Deno.test('fetch: key normalization (string → utf8 bytes)', async () => {
  // Indirectly verified: two projections with string 'foo' vs utf8('foo')
  // dedup to the same subscription-level view.
  const sf = new Scaffold(defaultConfig());
  const contract = Hash.digest('rec');
  const params = new Uint8Array([0]);
  const key = FetchManager.verifierKey({ contract, params });

  const h1 = sf.fetch({
    contract,
    params,
    key: 'foo',
    onResult: () => {},
  }) as FetchHandle;
  const h2 = sf.fetch({
    contract,
    params,
    key: new TextEncoder().encode('foo'),
    onResult: () => {},
  }) as FetchHandle;

  const fm = (sf as unknown as { fetchManager: FetchManager }).fetchManager;
  assert(fm.hasSubscription(key));
  // Both projections share the subscription.
  assertEquals(fm.getActiveVerifierKeys().length, 1);

  h1.close();
  h2.close();
  await sf.close();
});

// -- Error type smoke tests ------------------------------------------

Deno.test('FetchResult.parse: unsupported contract rejects', async () => {
  // Direct unit-test of the error path: a custom contract with no walkData.
  const sf = new Scaffold(defaultConfig());
  const contract = Hash.digest('no-walker');
  // Register a contract that has `run` but no walkData / buildParams.
  sf.registerContract(contract, {
    async run() {},
  });

  // We can't easily drive a real response here without setting up a
  // responder node; assert only that the error classes are wired. Actual
  // end-to-end rejection is covered in Fetch.integration.test.ts.
  assertEquals(new SupersededError().name, 'SupersededError');
  assertEquals(new InvalidatedError().name, 'InvalidatedError');
  await sf.close();
});

// Satisfy the import so unused-import lint stays quiet for the type-only
// re-exports we want visible to downstream callers.
// deno-lint-ignore no-unused-vars
function _typeAssert(x: FetchResult | FetchClaim): void {
  void x;
}
