import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { mulberry32, powerLaw, seedFromString } from '../harness/rand.ts';
import { haversineMeters, RandomUniformGeography } from '../harness/geography.ts';
import { buildUserPool, KeyPool } from '../harness/keypool.ts';
import { buildHarnessGenesis, loadGenesisFromHex } from '../harness/genesisBuilder.ts';
import { readPeerManifest, writePeerManifest } from '../harness/peerManifest.ts';
import type { PeerEntry } from '../harness/types.ts';

Deno.test('mulberry32: deterministic given seed', () => {
  const a = mulberry32(seedFromString('alpha'));
  const b = mulberry32(seedFromString('alpha'));
  assertEquals(a(), b());
  assertEquals(a(), b());
});

Deno.test('mulberry32: different seeds yield different sequences', () => {
  const a = mulberry32(seedFromString('alpha'));
  const b = mulberry32(seedFromString('beta'));
  assertNotEquals(a(), b());
});

Deno.test('powerLaw: samples within [min, max]', () => {
  const rand = mulberry32(1);
  for (let i = 0; i < 1000; i++) {
    const v = powerLaw(rand, 1.5, 100, 1_000_000);
    assert(v >= 100 && v <= 1_000_000, `out of range: ${v}`);
  }
});

Deno.test('haversineMeters: zero for identical coords', () => {
  const d = haversineMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 0 });
  assertEquals(d, 0);
});

Deno.test('haversineMeters: rough sanity for known pair', () => {
  // NY (40.7128, -74.0060) to SF (37.7749, -122.4194) = ~4130 km
  const d = haversineMeters(
    { lat: 40.7128, lon: -74.0060 },
    { lat: 37.7749, lon: -122.4194 },
  );
  assert(d > 4_000_000 && d < 4_200_000, `got ${d}`);
});

Deno.test('RandomUniformGeography: samples valid lat/lon', () => {
  const geo = new RandomUniformGeography({
    speedFactor: 0.5,
    jitterMinMs: 5,
    jitterMaxMs: 20,
    minMs: 5,
  });
  const rand = mulberry32(42);
  for (let i = 0; i < 100; i++) {
    const c = geo.sampleCoord(rand);
    assert(c.lat >= -90 && c.lat <= 90, `lat: ${c.lat}`);
    assert(c.lon >= -180 && c.lon <= 180, `lon: ${c.lon}`);
  }
});

Deno.test('RandomUniformGeography: latency respects floor', () => {
  const geo = new RandomUniformGeography({
    speedFactor: 0.5,
    jitterMinMs: 0,
    jitterMaxMs: 0,
    minMs: 50,
  });
  const rand = mulberry32(1);
  const ms = geo.oneWayLatencyMs({ lat: 0, lon: 0 }, { lat: 0, lon: 0 }, rand);
  assertEquals(ms, 50); // 0 great-circle + 0 jitter, floor applied
});

Deno.test('buildUserPool: honors zero_fraction', () => {
  const rand = mulberry32(7);
  const users = buildUserPool({
    count: 1000,
    seedPrefix: 'test',
    balance: {
      zeroFraction: 0.3,
      powerLaw: { alpha: 1.5, min: 100, max: 1_000_000 },
    },
  }, rand);
  const zeroes = users.filter((u) => u.balance === 0).length;
  assert(zeroes >= 250 && zeroes <= 350, `zeroes: ${zeroes}`);
});

Deno.test('buildUserPool: deterministic from seed', () => {
  const cfg = {
    count: 10,
    seedPrefix: 'det',
    balance: {
      zeroFraction: 0.2,
      powerLaw: { alpha: 1.5, min: 100, max: 10_000 },
    },
  };
  const a = buildUserPool(cfg, mulberry32(99));
  const b = buildUserPool(cfg, mulberry32(99));
  for (let i = 0; i < 10; i++) {
    assertEquals(a[i].pubkeyHex, b[i].pubkeyHex);
    assertEquals(a[i].balance, b[i].balance);
  }
});

Deno.test('KeyPool: checkout/return round-trip', () => {
  const users = buildUserPool({
    count: 3,
    seedPrefix: 'p',
    balance: { zeroFraction: 0, powerLaw: { alpha: 1.5, min: 1, max: 10 } },
  }, mulberry32(1));
  const pool = new KeyPool(users);
  assertEquals(pool.availableCount, 3);

  const a = pool.checkout(mulberry32(2));
  assert(a);
  assertEquals(pool.availableCount, 2);

  pool.return(a);
  assertEquals(pool.availableCount, 3);
});

Deno.test('KeyPool: exhausts and returns null', () => {
  const users = buildUserPool({
    count: 2,
    seedPrefix: 'p',
    balance: { zeroFraction: 0, powerLaw: { alpha: 1.5, min: 1, max: 10 } },
  }, mulberry32(1));
  const pool = new KeyPool(users);

  const a = pool.checkout(mulberry32(1));
  const b = pool.checkout(mulberry32(2));
  const c = pool.checkout(mulberry32(3));
  assert(a && b);
  assertEquals(c, null);
});

Deno.test('buildHarnessGenesis: excludes zero-balance users', () => {
  const users = [
    {
      seed: 'a',
      privateKey: new Uint8Array(32),
      publicKey: new Uint8Array(33),
      pubkeyHex: 'a',
      balance: 100,
    },
    {
      seed: 'b',
      privateKey: new Uint8Array(32),
      publicKey: new Uint8Array(33),
      pubkeyHex: 'b',
      balance: 0,
    },
    {
      seed: 'c',
      privateKey: new Uint8Array(32),
      publicKey: new Uint8Array(33),
      pubkeyHex: 'c',
      balance: 50,
    },
  ];
  const { block } = buildHarnessGenesis(users);
  assertEquals(block.outputs.length, 2);
});

Deno.test('buildHarnessGenesis: round-trips through hex', () => {
  const rand = mulberry32(5);
  const users = buildUserPool({
    count: 10,
    seedPrefix: 'gen',
    balance: { zeroFraction: 0.1, powerLaw: { alpha: 1.5, min: 100, max: 10_000 } },
  }, rand);
  const { block, packetHex } = buildHarnessGenesis(users);
  const roundTripped = loadGenesisFromHex(packetHex);
  assertEquals(roundTripped.hash.toHex(), block.hash.toHex());
  assertEquals(roundTripped.outputs.length, block.outputs.length);
});

Deno.test('peerManifest: write + read round-trip', async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/peers.json`;
  const peers: PeerEntry[] = [
    {
      sessionId: 's1',
      application: 'anchor',
      pubkeyHex: 'aa',
      address: '/tmp/x.sock',
      coord: { lat: 10, lon: 20 },
      startedAtMs: 123,
      isAnchor: true,
    },
  ];
  await writePeerManifest(path, { runId: 'r1', writtenAtMs: 1, peers });
  const roundTrip = await readPeerManifest(path);
  assert(roundTrip);
  assertEquals(roundTrip.peers.length, 1);
  assertEquals(roundTrip.peers[0].sessionId, 's1');
  await Deno.remove(dir, { recursive: true });
});

Deno.test('peerManifest: returns null for missing file', async () => {
  const result = await readPeerManifest('/tmp/does-not-exist-harness-test.json');
  assertEquals(result, null);
});
