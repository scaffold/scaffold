import { assert, assertEquals, assertRejects } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import type { ExecutionResult } from '../src/core/ContractHost.ts';
import {
  TrustGate,
  type TrustGateProvider,
  type TrustStatus,
  type VerdictQuery,
  type VerificationStatus,
} from '../src/node/TrustGate.ts';
import {
  CollateralRejectedError,
  TrustTimeoutError,
  VerificationRejectedError,
} from '../src/node/TrustErrors.ts';

// -- Mock provider ---------------------------------------------------

class MockProvider implements TrustGateProvider {
  readonly verifyStatus = new Map<string, VerificationStatus>();
  readonly verdicts = new Map<string, VerdictQuery>();
  readonly requestCalls: string[] = [];
  /** Set before awaitTrusted to inject a deferred result (we still drive transitions manually). */
  requestResolver: (h: Hash) => Promise<ExecutionResult> = () =>
    Promise.resolve({ accepted: true });

  private readonly verifyCbs: ((h: Hash, s: VerificationStatus) => void)[] = [];
  private readonly verdictCbs: ((h: Hash, v: VerdictQuery) => void)[] = [];

  getVerificationStatus(h: Hash): VerificationStatus {
    return this.verifyStatus.get(h.toHex()) ?? 'unknown';
  }
  onVerificationStatusChanged(
    cb: (h: Hash, s: VerificationStatus) => void,
  ): () => void {
    this.verifyCbs.push(cb);
    return () => {};
  }
  requestVerification(h: Hash): Promise<ExecutionResult> {
    this.requestCalls.push(h.toHex());
    return this.requestResolver(h);
  }
  getVerdict(h: Hash): VerdictQuery {
    return this.verdicts.get(h.toHex()) ?? 'none';
  }
  onVerdictChanged(cb: (h: Hash, v: VerdictQuery) => void): () => void {
    this.verdictCbs.push(cb);
    return () => {};
  }

  setVerification(h: Hash, s: VerificationStatus): void {
    this.verifyStatus.set(h.toHex(), s);
    for (const cb of this.verifyCbs) cb(h, s);
  }
  setVerdict(h: Hash, v: VerdictQuery): void {
    this.verdicts.set(h.toHex(), v);
    for (const cb of this.verdictCbs) cb(h, v);
  }
}

const H = (s: string): Hash => Hash.digest(s);

// -- Tests ------------------------------------------------------------

Deno.test('TG: verification passed => trusted(verified)', () => {
  const p = new MockProvider();
  const tg = new TrustGate(p);
  const h = H('x');
  p.setVerification(h, 'passed');
  assertEquals(tg.status(h), { kind: 'trusted', basis: 'verified' });
});

Deno.test('TG: verification failed => rejected(local verification)', () => {
  const p = new MockProvider();
  const tg = new TrustGate(p);
  const h = H('x');
  p.setVerification(h, 'failed');
  assertEquals(tg.status(h), { kind: 'rejected', reason: 'local verification' });
});

Deno.test('TG: verdict=valid alone => trusted(collateralized)', () => {
  const p = new MockProvider();
  const tg = new TrustGate(p);
  const h = H('x');
  p.setVerdict(h, 'valid');
  assertEquals(tg.status(h), { kind: 'trusted', basis: 'collateralized' });
});

Deno.test('TG: verdict=invalid alone => rejected(collateral resolution)', () => {
  const p = new MockProvider();
  const tg = new TrustGate(p);
  const h = H('x');
  p.setVerdict(h, 'invalid');
  assertEquals(tg.status(h), {
    kind: 'rejected',
    reason: 'collateral resolution',
  });
});

Deno.test('TG: local verify OVERRIDES collateral invalid (under-funded FOR)', () => {
  const p = new MockProvider();
  const tg = new TrustGate(p);
  const h = H('x');
  p.setVerdict(h, 'invalid'); // network says invalid (AGAINST stake won)
  p.setVerification(h, 'passed'); // we verified it ourselves -- it's valid
  assertEquals(tg.status(h), { kind: 'trusted', basis: 'verified' });
});

Deno.test('TG: local verify failure OVERRIDES collateral valid', () => {
  const p = new MockProvider();
  const tg = new TrustGate(p);
  const h = H('x');
  p.setVerdict(h, 'valid');
  p.setVerification(h, 'failed');
  assertEquals(tg.status(h), { kind: 'rejected', reason: 'local verification' });
});

Deno.test('TG: trusted(verified) sticks through verdict flips', () => {
  const p = new MockProvider();
  const tg = new TrustGate(p);
  const h = H('x');
  p.setVerification(h, 'passed');
  p.setVerdict(h, 'valid');
  assertEquals(tg.status(h).kind, 'trusted');
  p.setVerdict(h, 'invalid');
  assertEquals(tg.status(h), { kind: 'trusted', basis: 'verified' });
  p.setVerdict(h, 'none');
  assertEquals(tg.status(h), { kind: 'trusted', basis: 'verified' });
});

Deno.test('TG: awaitTrusted resolves synchronously when already trusted', async () => {
  const p = new MockProvider();
  const tg = new TrustGate(p);
  const h = H('x');
  p.setVerification(h, 'passed');
  const s = await tg.awaitTrusted(h);
  assertEquals(s, { kind: 'trusted', basis: 'verified' });
  assertEquals(p.requestCalls.length, 0);
});

Deno.test('TG: awaitTrusted rejects synchronously on already-rejected', async () => {
  const p = new MockProvider();
  const tg = new TrustGate(p);
  const h = H('x');
  p.setVerification(h, 'failed');
  await assertRejects(() => tg.awaitTrusted(h), VerificationRejectedError);
});

Deno.test('TG: awaitTrusted resolves on passed transition; calls requestVerification once', async () => {
  const p = new MockProvider();
  const tg = new TrustGate(p);
  const h = H('x');
  const promise = tg.awaitTrusted(h);
  // microtask: allow the requestVerification call to happen
  await Promise.resolve();
  assertEquals(p.requestCalls, [h.toHex()]);
  p.setVerification(h, 'passed');
  const s = await promise;
  assertEquals(s.basis, 'verified');
});

Deno.test('TG: awaitTrusted rejects on failed transition', async () => {
  const p = new MockProvider();
  const tg = new TrustGate(p);
  const h = H('x');
  const promise = tg.awaitTrusted(h);
  await Promise.resolve();
  p.setVerification(h, 'failed');
  await assertRejects(() => promise, VerificationRejectedError);
});

Deno.test('TG: awaitTrusted resolves on verdict=valid transition (collateralized basis)', async () => {
  const p = new MockProvider();
  const tg = new TrustGate(p);
  const h = H('x');
  const promise = tg.awaitTrusted(h);
  await Promise.resolve();
  p.setVerdict(h, 'valid');
  const s = await promise;
  assertEquals(s.basis, 'collateralized');
});

Deno.test('TG: awaitTrusted rejects on verdict=invalid transition', async () => {
  const p = new MockProvider();
  const tg = new TrustGate(p);
  const h = H('x');
  const promise = tg.awaitTrusted(h);
  await Promise.resolve();
  p.setVerdict(h, 'invalid');
  await assertRejects(() => promise, CollateralRejectedError);
});

Deno.test('TG: awaitTrusted times out', async () => {
  const p = new MockProvider();
  // Prevent requestVerification from ever resolving.
  p.requestResolver = () => new Promise(() => {});
  const tg = new TrustGate(p);
  const h = H('x');
  await assertRejects(
    () => tg.awaitTrusted(h, { timeoutMs: 5 }),
    TrustTimeoutError,
  );
});

Deno.test('TG: onTrustChanged fires once per real transition, not per read', () => {
  const p = new MockProvider();
  const tg = new TrustGate(p);
  const h = H('x');
  const events: TrustStatus[] = [];
  tg.onTrustChanged((_h, s) => events.push(s));

  // untrusted -> collateralized
  p.setVerdict(h, 'valid');
  assertEquals(events.length, 1);
  assertEquals(events[0], { kind: 'trusted', basis: 'collateralized' });

  // setting the same verdict again: no new event
  p.setVerdict(h, 'valid');
  assertEquals(events.length, 1);

  // escalate to verified
  p.setVerification(h, 'passed');
  assertEquals(events.length, 2);
  assertEquals(events[1], { kind: 'trusted', basis: 'verified' });

  // multiple reads of status shouldn't fire anything
  for (let i = 0; i < 3; i++) tg.status(h);
  assertEquals(events.length, 2);
});

Deno.test('TG: onTrustChanged filters stale transitions across different hashes', () => {
  const p = new MockProvider();
  const tg = new TrustGate(p);
  const a = H('a');
  const b = H('b');
  const events: { h: string; s: TrustStatus }[] = [];
  tg.onTrustChanged((h, s) => events.push({ h: h.toHex(), s }));
  p.setVerification(a, 'passed');
  p.setVerification(b, 'failed');
  assertEquals(events.length, 2);
  assertEquals(events[0].h, a.toHex());
  assertEquals(events[1].h, b.toHex());
});

Deno.test('TG: awaitTrusted ignores transitions on unrelated hashes', async () => {
  const p = new MockProvider();
  const tg = new TrustGate(p);
  const a = H('a');
  const b = H('b');
  const promise = tg.awaitTrusted(a);
  await Promise.resolve();
  p.setVerification(b, 'passed'); // shouldn't resolve promise
  // Now resolve a properly.
  p.setVerification(a, 'passed');
  const s = await promise;
  assert(s.kind === 'trusted');
});
