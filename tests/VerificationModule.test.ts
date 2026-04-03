import { assert, assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { ExecutionResult } from '../src/core/ExecutionModule.ts';
import { ProbeResult } from '../src/core/ProbeModule.ts';
import { VerificationModule, VerificationProvider } from '../src/core/VerificationModule.ts';

// -- Test helpers ----------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);

class MockVerificationProvider implements VerificationProvider {
  private readonly trees: Hash[] = [];
  private readonly probeResults = new Map<string, ProbeResult>();
  private readonly execResults = new Map<string, ExecutionResult>();
  readonly verifications: { hash: Hash; success: boolean }[] = [];

  /** Queue a tree to be selected by selectNextTree (FIFO). */
  addTree(hash: Hash): void {
    this.trees.push(hash);
  }

  /** Set the probe result for a tree. */
  setProbeResult(treeHash: Hash, result: ProbeResult): void {
    this.probeResults.set(treeHash.toHex(), result);
  }

  /** Set the execution result for a specific block. */
  setExecResult(hash: Hash, result: ExecutionResult): void {
    this.execResults.set(hash.toHex(), result);
  }

  selectNextTree(): Hash | undefined {
    return this.trees.shift();
  }

  initProbe(treeHash: Hash): ProbeResult {
    return this.probeResults.get(treeHash.toHex()) ??
      { terminal: false, reason: 'missing' as const };
  }

  verifyBlock(blockHash: Hash): ExecutionResult {
    const result = this.execResults.get(blockHash.toHex());
    if (!result) return { accepted: false, reason: 'no mock result configured' };
    return result;
  }

  recordVerification(blockHash: Hash, success: boolean): void {
    this.verifications.push({ hash: blockHash, success });
  }
}

function setup() {
  const provider = new MockVerificationProvider();
  const module = new VerificationModule(provider);
  return { provider, module };
}

// -- Tests -----------------------------------------------------------

Deno.test('VerificationModule: verifyNext selects tree, probes, and verifies', () => {
  const { provider, module } = setup();

  const tree = h('tree-1');
  const terminal = h('terminal-1');
  provider.addTree(tree);
  provider.setProbeResult(tree, { terminal: true, blockHash: terminal });
  provider.setExecResult(terminal, { accepted: true });

  const result = module.verifyNext();
  assert(result.verified);
  if (result.verified) {
    assertEquals(result.treeHash.toHex(), tree.toHex());
    assertEquals(result.terminalHash.toHex(), terminal.toHex());
  }
});

Deno.test('VerificationModule: verifyNext returns "nothing to verify" when no trees', () => {
  const { module } = setup();

  const result = module.verifyNext();
  assert(!result.verified);
  if (!result.verified) {
    assertEquals(result.treeHash, undefined);
    assert(result.reason.includes('no trees'));
  }
});

Deno.test('VerificationModule: successful verification records success', () => {
  const { provider, module } = setup();

  const tree = h('valid-tree');
  const terminal = h('terminal');
  provider.addTree(tree);
  provider.setProbeResult(tree, { terminal: true, blockHash: terminal });
  provider.setExecResult(terminal, { accepted: true });

  module.verifyNext();

  assertEquals(provider.verifications.length, 1);
  assertEquals(provider.verifications[0].hash.toHex(), terminal.toHex());
  assertEquals(provider.verifications[0].success, true);
});

Deno.test('VerificationModule: failed verification records failure', () => {
  const { provider, module } = setup();

  const tree = h('invalid-tree');
  const terminal = h('terminal');
  provider.addTree(tree);
  provider.setProbeResult(tree, { terminal: true, blockHash: terminal });
  provider.setExecResult(terminal, { accepted: false, reason: 'contract rejected' });

  const result = module.verifyNext();
  assert(!result.verified);
  if (!result.verified && result.treeHash) {
    assertEquals(result.reason, 'contract rejected');
  }

  assertEquals(provider.verifications.length, 1);
  assertEquals(provider.verifications[0].success, false);
});

Deno.test('VerificationModule: non-terminal probe returns probe reason', () => {
  const { provider, module } = setup();

  const tree = h('missing-tree');
  provider.addTree(tree);
  provider.setProbeResult(tree, { terminal: false, reason: 'missing' });

  const result = module.verifyNext();
  assert(!result.verified);
  if (!result.verified) {
    assertEquals(result.reason, 'missing');
  }

  // No verification recorded since probe didn't reach a terminal
  assertEquals(provider.verifications.length, 0);
});

Deno.test('VerificationModule: multiple verifyNext calls process in order', () => {
  const { provider, module } = setup();

  const tree1 = h('tree-1');
  const tree2 = h('tree-2');
  const tree3 = h('tree-3');
  const t1 = h('terminal-1');
  const t2 = h('terminal-2');
  const t3 = h('terminal-3');

  provider.addTree(tree1);
  provider.addTree(tree2);
  provider.addTree(tree3);
  provider.setProbeResult(tree1, { terminal: true, blockHash: t1 });
  provider.setProbeResult(tree2, { terminal: true, blockHash: t2 });
  provider.setProbeResult(tree3, { terminal: true, blockHash: t3 });
  provider.setExecResult(t1, { accepted: true });
  provider.setExecResult(t2, { accepted: false, reason: 'bad' });
  provider.setExecResult(t3, { accepted: true });

  assert(module.verifyNext().verified);
  assert(!module.verifyNext().verified);
  assert(module.verifyNext().verified);

  // Fourth call has no more trees
  const r4 = module.verifyNext();
  assert(!r4.verified);
  if (!r4.verified) assertEquals(r4.treeHash, undefined);

  const successes = provider.verifications.filter((v) => v.success).length;
  const failures = provider.verifications.filter((v) => !v.success).length;
  assertEquals(successes, 2);
  assertEquals(failures, 1);
});
