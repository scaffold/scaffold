import { assert, assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { ExecutionResult } from '../src/core/ExecutionModule.ts';
import { VerificationModule, VerificationProvider } from '../src/core/VerificationModule.ts';

// -- Test helpers ----------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);

class MockVerificationProvider implements VerificationProvider {
  private readonly trees: Hash[] = [];
  private readonly results = new Map<string, ExecutionResult>();
  readonly successReports: Hash[] = [];
  readonly failureReports: Hash[] = [];

  /** Queue a tree to be selected by selectNextTree (FIFO). */
  addTree(hash: Hash): void {
    this.trees.push(hash);
  }

  /** Set the verification result for a specific block. */
  setResult(hash: Hash, result: ExecutionResult): void {
    this.results.set(hash.toHex(), result);
  }

  selectNextTree(): Hash | undefined {
    return this.trees.shift();
  }

  verifyBlock(blockHash: Hash): ExecutionResult {
    const result = this.results.get(blockHash.toHex());
    if (!result) return { accepted: false, reason: 'no mock result configured' };
    return result;
  }

  reportSuccess(treeHash: Hash): void {
    this.successReports.push(treeHash);
  }

  reportFailure(treeHash: Hash): void {
    this.failureReports.push(treeHash);
  }
}

function setup() {
  const provider = new MockVerificationProvider();
  const module = new VerificationModule(provider);
  return { provider, module };
}

// -- Tests -----------------------------------------------------------

Deno.test('VerificationModule: verifyNext selects highest-priority tree', () => {
  const { provider, module } = setup();

  const tree = h('tree-1');
  provider.addTree(tree);
  provider.setResult(tree, { accepted: true });

  const result = module.verifyNext();
  assert(result.verified);
  if (result.verified) {
    assertEquals(result.treeHash.toHex(), tree.toHex());
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

Deno.test('VerificationModule: successful verification reports to sampling', () => {
  const { provider, module } = setup();

  const tree = h('valid-tree');
  provider.addTree(tree);
  provider.setResult(tree, { accepted: true });

  const result = module.verifyNext();
  assert(result.verified);

  assertEquals(provider.successReports.length, 1);
  assertEquals(provider.successReports[0].toHex(), tree.toHex());
  assertEquals(provider.failureReports.length, 0);
});

Deno.test('VerificationModule: failed verification reports failure', () => {
  const { provider, module } = setup();

  const tree = h('invalid-tree');
  provider.addTree(tree);
  provider.setResult(tree, { accepted: false, reason: 'contract rejected' });

  const result = module.verifyNext();
  assert(!result.verified);
  if (!result.verified) {
    assert(result.treeHash !== undefined);
    assertEquals(result.reason, 'contract rejected');
  }

  assertEquals(provider.failureReports.length, 1);
  assertEquals(provider.failureReports[0].toHex(), tree.toHex());
  assertEquals(provider.successReports.length, 0);
});

Deno.test('VerificationModule: verify specific block', () => {
  const { provider, module } = setup();

  const block = h('specific-block');
  provider.setResult(block, { accepted: true });

  const result = module.verify(block);
  assert(result.verified);

  assertEquals(provider.successReports.length, 1);
  assertEquals(provider.successReports[0].toHex(), block.toHex());
});

Deno.test('VerificationModule: multiple verifyNext calls process in order', () => {
  const { provider, module } = setup();

  const tree1 = h('tree-1');
  const tree2 = h('tree-2');
  const tree3 = h('tree-3');
  provider.addTree(tree1);
  provider.addTree(tree2);
  provider.addTree(tree3);
  provider.setResult(tree1, { accepted: true });
  provider.setResult(tree2, { accepted: false, reason: 'bad' });
  provider.setResult(tree3, { accepted: true });

  const r1 = module.verifyNext();
  assert(r1.verified);

  const r2 = module.verifyNext();
  assert(!r2.verified);

  const r3 = module.verifyNext();
  assert(r3.verified);

  // Fourth call has no more trees
  const r4 = module.verifyNext();
  assert(!r4.verified);
  if (!r4.verified) {
    assertEquals(r4.treeHash, undefined);
  }

  assertEquals(provider.successReports.length, 2);
  assertEquals(provider.failureReports.length, 1);
});

Deno.test('VerificationModule: full loop — add trees, select, verify, sampling updated', () => {
  const { provider, module } = setup();

  // Simulate adding trees and verifying them
  const validTree = h('valid');
  const invalidTree = h('invalid');
  provider.addTree(validTree);
  provider.addTree(invalidTree);
  provider.setResult(validTree, { accepted: true });
  provider.setResult(invalidTree, { accepted: false, reason: 'wrong state' });

  // First verification: valid tree
  module.verifyNext();
  assertEquals(provider.successReports.length, 1);
  assertEquals(provider.failureReports.length, 0);

  // Second verification: invalid tree
  module.verifyNext();
  assertEquals(provider.successReports.length, 1);
  assertEquals(provider.failureReports.length, 1);

  // Verify specific trees directly
  provider.setResult(validTree, { accepted: true });
  module.verify(validTree);
  assertEquals(provider.successReports.length, 2);
});
