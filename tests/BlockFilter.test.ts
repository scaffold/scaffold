import { assertEquals } from '@std/assert';
import {
  type BooleanPredicate,
  type ComparisonPredicate,
  type FunctionPredicate,
  type HashPredicate,
  parseDuration,
  parseQuery,
} from '../explorer/src/filter/parse.ts';
import {
  type BlockInfo,
  compareValues,
  evaluatePredicate,
  evaluateQuery,
  evaluateTerm,
} from '../explorer/src/filter/evaluate.ts';
import { type BlockEdges, computeGhostHashes } from '../explorer/src/filter/ghost.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlock(overrides?: Partial<BlockInfo>): BlockInfo {
  return {
    hash: 'abcdef1234567890'.repeat(4),
    isCanonical: false,
    isHead: false,
    isGenesis: false,
    isLeaf: false,
    declaredWeight: 10,
    throughput: 100,
    receivedAt: Date.now(),
    outputContracts: [],
    ...overrides,
  };
}

// ===========================================================================
// Parser tests
// ===========================================================================

Deno.test('parseQuery: empty string returns empty query', () => {
  const result = parseQuery('');
  assertEquals(result, []);
});

Deno.test('parseQuery: single boolean predicate', () => {
  const result = parseQuery('canonical');
  assertEquals(result.length, 1); // one term
  assertEquals(result[0].length, 1); // one predicate
  const pred = result[0][0] as BooleanPredicate;
  assertEquals(pred, { type: 'boolean', name: 'canonical', negated: false });
});

Deno.test('parseQuery: multiple boolean predicates (AND)', () => {
  const result = parseQuery('canonical head');
  assertEquals(result.length, 1); // one term
  assertEquals(result[0].length, 2); // two predicates
  const p0 = result[0][0] as BooleanPredicate;
  const p1 = result[0][1] as BooleanPredicate;
  assertEquals(p0, { type: 'boolean', name: 'canonical', negated: false });
  assertEquals(p1, { type: 'boolean', name: 'head', negated: false });
});

Deno.test('parseQuery: comma-separated terms (OR)', () => {
  const result = parseQuery('canonical, head');
  assertEquals(result.length, 2); // two terms
  assertEquals(result[0].length, 1);
  assertEquals(result[1].length, 1);
  const t0 = result[0][0] as BooleanPredicate;
  const t1 = result[1][0] as BooleanPredicate;
  assertEquals(t0, { type: 'boolean', name: 'canonical', negated: false });
  assertEquals(t1, { type: 'boolean', name: 'head', negated: false });
});

Deno.test('parseQuery: negation', () => {
  const result = parseQuery('-canonical');
  assertEquals(result.length, 1);
  assertEquals(result[0].length, 1);
  const pred = result[0][0] as BooleanPredicate;
  assertEquals(pred, { type: 'boolean', name: 'canonical', negated: true });
});

Deno.test('parseQuery: comparison with operator', () => {
  const result = parseQuery('weight:>100');
  assertEquals(result.length, 1);
  assertEquals(result[0].length, 1);
  const pred = result[0][0] as ComparisonPredicate;
  assertEquals(pred, {
    type: 'comparison',
    key: 'weight',
    op: '>',
    value: 100,
    negated: false,
  });
});

Deno.test('parseQuery: comparison with bare number (equals)', () => {
  const result = parseQuery('weight:100');
  assertEquals(result.length, 1);
  assertEquals(result[0].length, 1);
  const pred = result[0][0] as ComparisonPredicate;
  assertEquals(pred, {
    type: 'comparison',
    key: 'weight',
    op: '=',
    value: 100,
    negated: false,
  });
});

Deno.test('parseQuery: age duration', () => {
  const result = parseQuery('age:<5m');
  assertEquals(result.length, 1);
  assertEquals(result[0].length, 1);
  const pred = result[0][0] as ComparisonPredicate;
  assertEquals(pred, {
    type: 'comparison',
    key: 'age',
    op: '<',
    value: 300_000,
    negated: false,
  });
});

Deno.test('parseQuery: function predicate', () => {
  const result = parseQuery('outputs(abc123)');
  assertEquals(result.length, 1);
  assertEquals(result[0].length, 1);
  const pred = result[0][0] as FunctionPredicate;
  assertEquals(pred, {
    type: 'function',
    name: 'outputs',
    args: ['abc123'],
    negated: false,
  });
});

Deno.test('parseQuery: hash prefix', () => {
  const result = parseQuery('abcd1234');
  assertEquals(result.length, 1);
  assertEquals(result[0].length, 1);
  const pred = result[0][0] as HashPredicate;
  assertEquals(pred, { type: 'hash', prefix: 'abcd1234', negated: false });
});

Deno.test('parseQuery: complex query with two terms', () => {
  const result = parseQuery('canonical weight:>100, -genesis');
  // Two terms (OR)
  assertEquals(result.length, 2);
  // First term: canonical AND weight:>100
  assertEquals(result[0].length, 2);
  assertEquals(result[0][0], {
    type: 'boolean',
    name: 'canonical',
    negated: false,
  });
  assertEquals(result[0][1], {
    type: 'comparison',
    key: 'weight',
    op: '>',
    value: 100,
    negated: false,
  });
  // Second term: -genesis
  assertEquals(result[1].length, 1);
  assertEquals(result[1][0], {
    type: 'boolean',
    name: 'genesis',
    negated: true,
  });
});

Deno.test('parseQuery: negated comparison', () => {
  const result = parseQuery('-weight:>100');
  assertEquals(result.length, 1);
  assertEquals(result[0].length, 1);
  const pred = result[0][0] as ComparisonPredicate;
  assertEquals(pred, {
    type: 'comparison',
    key: 'weight',
    op: '>',
    value: 100,
    negated: true,
  });
});

Deno.test('parseDuration: all duration suffixes', () => {
  assertEquals(parseDuration('30s'), 30_000);
  assertEquals(parseDuration('5m'), 300_000);
  assertEquals(parseDuration('1h'), 3_600_000);
});

Deno.test('parseDuration: invalid duration returns null', () => {
  assertEquals(parseDuration('5x'), null);
  assertEquals(parseDuration('abc'), null);
});

Deno.test('parseQuery: whitespace handling', () => {
  const normal = parseQuery('canonical head');
  const padded = parseQuery('  canonical   head  ');
  assertEquals(padded, normal);
});

Deno.test('parseQuery: comparison operators >=, <, <=', () => {
  const geResult = parseQuery('weight:>=50');
  assertEquals((geResult[0][0] as ComparisonPredicate).op, '>=');
  assertEquals((geResult[0][0] as ComparisonPredicate).value, 50);

  const ltResult = parseQuery('weight:<20');
  assertEquals((ltResult[0][0] as ComparisonPredicate).op, '<');
  assertEquals((ltResult[0][0] as ComparisonPredicate).value, 20);

  const leResult = parseQuery('weight:<=20');
  assertEquals((leResult[0][0] as ComparisonPredicate).op, '<=');
  assertEquals((leResult[0][0] as ComparisonPredicate).value, 20);
});

Deno.test('parseQuery: throughput comparison', () => {
  const result = parseQuery('throughput:>1000');
  assertEquals(result.length, 1);
  assertEquals(result[0].length, 1);
  const pred = result[0][0] as ComparisonPredicate;
  assertEquals(pred.type, 'comparison');
  assertEquals(pred.key, 'throughput');
  assertEquals(pred.op, '>');
  assertEquals(pred.value, 1000);
});

// ===========================================================================
// Evaluator tests
// ===========================================================================

Deno.test('evaluateQuery: empty query matches nothing', () => {
  const block = makeBlock();
  assertEquals(evaluateQuery([], block), false);
});

Deno.test('evaluatePredicate: boolean canonical matches canonical block', () => {
  const pred: BooleanPredicate = {
    type: 'boolean',
    name: 'canonical',
    negated: false,
  };
  const now = Date.now();
  assertEquals(
    evaluatePredicate(pred, makeBlock({ isCanonical: true }), now),
    true,
  );
  assertEquals(
    evaluatePredicate(pred, makeBlock({ isCanonical: false }), now),
    false,
  );
});

Deno.test('evaluatePredicate: boolean head matches head block', () => {
  const pred: BooleanPredicate = {
    type: 'boolean',
    name: 'head',
    negated: false,
  };
  const now = Date.now();
  assertEquals(evaluatePredicate(pred, makeBlock({ isHead: true }), now), true);
  assertEquals(
    evaluatePredicate(pred, makeBlock({ isHead: false }), now),
    false,
  );
});

Deno.test('evaluatePredicate: boolean genesis matches genesis block', () => {
  const pred: BooleanPredicate = {
    type: 'boolean',
    name: 'genesis',
    negated: false,
  };
  const now = Date.now();
  assertEquals(
    evaluatePredicate(pred, makeBlock({ isGenesis: true }), now),
    true,
  );
  assertEquals(
    evaluatePredicate(pred, makeBlock({ isGenesis: false }), now),
    false,
  );
});

Deno.test('evaluatePredicate: boolean leaf matches leaf block', () => {
  const pred: BooleanPredicate = {
    type: 'boolean',
    name: 'leaf',
    negated: false,
  };
  const now = Date.now();
  assertEquals(evaluatePredicate(pred, makeBlock({ isLeaf: true }), now), true);
  assertEquals(
    evaluatePredicate(pred, makeBlock({ isLeaf: false }), now),
    false,
  );
});

Deno.test('evaluatePredicate: negation inverts result', () => {
  const pred: BooleanPredicate = {
    type: 'boolean',
    name: 'canonical',
    negated: true,
  };
  const now = Date.now();
  // Negated canonical matches non-canonical block
  assertEquals(
    evaluatePredicate(pred, makeBlock({ isCanonical: false }), now),
    true,
  );
  // Negated canonical rejects canonical block
  assertEquals(
    evaluatePredicate(pred, makeBlock({ isCanonical: true }), now),
    false,
  );
});

Deno.test('evaluateTerm: AND within term requires all predicates true', () => {
  const term = [
    { type: 'boolean', name: 'canonical', negated: false } as BooleanPredicate,
    { type: 'boolean', name: 'head', negated: false } as BooleanPredicate,
  ];
  const now = Date.now();
  // Both true
  assertEquals(
    evaluateTerm(term, makeBlock({ isCanonical: true, isHead: true }), now),
    true,
  );
  // One false
  assertEquals(
    evaluateTerm(term, makeBlock({ isCanonical: true, isHead: false }), now),
    false,
  );
  assertEquals(
    evaluateTerm(term, makeBlock({ isCanonical: false, isHead: true }), now),
    false,
  );
});

Deno.test('evaluateQuery: OR across terms matches when either is true', () => {
  const query = [
    [{
      type: 'boolean',
      name: 'canonical',
      negated: false,
    } as BooleanPredicate],
    [{ type: 'boolean', name: 'head', negated: false } as BooleanPredicate],
  ];
  // Canonical but not head -> matches first term
  assertEquals(
    evaluateQuery(query, makeBlock({ isCanonical: true, isHead: false })),
    true,
  );
  // Head but not canonical -> matches second term
  assertEquals(
    evaluateQuery(query, makeBlock({ isCanonical: false, isHead: true })),
    true,
  );
  // Neither -> no match
  assertEquals(
    evaluateQuery(query, makeBlock({ isCanonical: false, isHead: false })),
    false,
  );
});

Deno.test('evaluatePredicate: weight comparison >', () => {
  const pred: ComparisonPredicate = {
    type: 'comparison',
    key: 'weight',
    op: '>',
    value: 5,
    negated: false,
  };
  const now = Date.now();
  assertEquals(
    evaluatePredicate(pred, makeBlock({ declaredWeight: 10 }), now),
    true,
  );
  assertEquals(
    evaluatePredicate(pred, makeBlock({ declaredWeight: 3 }), now),
    false,
  );
});

Deno.test('evaluatePredicate: weight comparison =', () => {
  const pred: ComparisonPredicate = {
    type: 'comparison',
    key: 'weight',
    op: '=',
    value: 10,
    negated: false,
  };
  const now = Date.now();
  assertEquals(
    evaluatePredicate(pred, makeBlock({ declaredWeight: 10 }), now),
    true,
  );
  assertEquals(
    evaluatePredicate(pred, makeBlock({ declaredWeight: 11 }), now),
    false,
  );
});

Deno.test('evaluatePredicate: throughput comparison', () => {
  const pred: ComparisonPredicate = {
    type: 'comparison',
    key: 'throughput',
    op: '>',
    value: 50,
    negated: false,
  };
  const now = Date.now();
  assertEquals(
    evaluatePredicate(pred, makeBlock({ throughput: 100 }), now),
    true,
  );
  assertEquals(
    evaluatePredicate(pred, makeBlock({ throughput: 30 }), now),
    false,
  );
});

Deno.test('evaluatePredicate: age comparison', () => {
  const now = 1_000_000;
  const pred: ComparisonPredicate = {
    type: 'comparison',
    key: 'age',
    op: '<',
    value: 60_000, // less than 1 minute old
    negated: false,
  };
  // Block received 30s ago (age = 30000 < 60000) -> match
  assertEquals(
    evaluatePredicate(pred, makeBlock({ receivedAt: now - 30_000 }), now),
    true,
  );
  // Block received 2min ago (age = 120000 > 60000) -> reject
  assertEquals(
    evaluatePredicate(pred, makeBlock({ receivedAt: now - 120_000 }), now),
    false,
  );
});

Deno.test('evaluatePredicate: function outputs matches contract prefix', () => {
  const pred: FunctionPredicate = {
    type: 'function',
    name: 'outputs',
    args: ['abc123'],
    negated: false,
  };
  const now = Date.now();
  assertEquals(
    evaluatePredicate(
      pred,
      makeBlock({ outputContracts: ['abc12300deadbeef'] }),
      now,
    ),
    true,
  );
  assertEquals(
    evaluatePredicate(
      pred,
      makeBlock({ outputContracts: ['ffffffff00000000'] }),
      now,
    ),
    false,
  );
});

Deno.test('evaluatePredicate: hash prefix matches', () => {
  const pred: HashPredicate = {
    type: 'hash',
    prefix: 'abcdef12',
    negated: false,
  };
  const now = Date.now();
  assertEquals(
    evaluatePredicate(
      pred,
      makeBlock({ hash: 'abcdef1234567890'.repeat(4) }),
      now,
    ),
    true,
  );
});

Deno.test('evaluatePredicate: hash prefix rejects non-match', () => {
  const pred: HashPredicate = {
    type: 'hash',
    prefix: 'ffffff',
    negated: false,
  };
  const now = Date.now();
  assertEquals(
    evaluatePredicate(
      pred,
      makeBlock({ hash: 'abcdef1234567890'.repeat(4) }),
      now,
    ),
    false,
  );
});

Deno.test('compareValues: all five operators', () => {
  // >
  assertEquals(compareValues(10, '>', 5), true);
  assertEquals(compareValues(5, '>', 5), false);
  // >=
  assertEquals(compareValues(5, '>=', 5), true);
  assertEquals(compareValues(4, '>=', 5), false);
  // <
  assertEquals(compareValues(3, '<', 5), true);
  assertEquals(compareValues(5, '<', 5), false);
  // <=
  assertEquals(compareValues(5, '<=', 5), true);
  assertEquals(compareValues(6, '<=', 5), false);
  // =
  assertEquals(compareValues(5, '=', 5), true);
  assertEquals(compareValues(6, '=', 5), false);
});

// ===========================================================================
// Ghost computation tests
// ===========================================================================

Deno.test('computeGhostHashes: no visible blocks returns empty set', () => {
  const result = computeGhostHashes(new Set(), []);
  assertEquals(result.size, 0);
});

Deno.test('computeGhostHashes: anchor neighbor becomes ghost', () => {
  const blockA: BlockEdges = {
    hash: 'aaaa',
    anchor: 'bbbb',
    aggregates: [],
    refs: [],
  };
  const blockB: BlockEdges = {
    hash: 'bbbb',
    anchor: '0'.repeat(64),
    aggregates: [],
    refs: [],
  };
  const visible = new Set(['aaaa']);
  const ghosts = computeGhostHashes(visible, [blockA, blockB]);
  assertEquals(ghosts.has('bbbb'), true);
});

Deno.test('computeGhostHashes: aggregate neighbor becomes ghost', () => {
  const blockA: BlockEdges = {
    hash: 'aaaa',
    anchor: '0'.repeat(64),
    aggregates: ['cccc'],
    refs: [],
  };
  const blockC: BlockEdges = {
    hash: 'cccc',
    anchor: '0'.repeat(64),
    aggregates: [],
    refs: [],
  };
  const visible = new Set(['aaaa']);
  const ghosts = computeGhostHashes(visible, [blockA, blockC]);
  assertEquals(ghosts.has('cccc'), true);
});

Deno.test('computeGhostHashes: ref neighbor becomes ghost', () => {
  const blockA: BlockEdges = {
    hash: 'aaaa',
    anchor: '0'.repeat(64),
    aggregates: [],
    refs: ['dddd'],
  };
  const blockD: BlockEdges = {
    hash: 'dddd',
    anchor: '0'.repeat(64),
    aggregates: [],
    refs: [],
  };
  const visible = new Set(['aaaa']);
  const ghosts = computeGhostHashes(visible, [blockA, blockD]);
  assertEquals(ghosts.has('dddd'), true);
});

Deno.test('computeGhostHashes: reverse direction -- child anchor makes parent ghost', () => {
  // Block B has anchor A. A is visible, so B (the child that references A) becomes ghost.
  const blockA: BlockEdges = {
    hash: 'aaaa',
    anchor: '0'.repeat(64),
    aggregates: [],
    refs: [],
  };
  const blockB: BlockEdges = {
    hash: 'bbbb',
    anchor: 'aaaa',
    aggregates: [],
    refs: [],
  };
  const visible = new Set(['aaaa']);
  const ghosts = computeGhostHashes(visible, [blockA, blockB]);
  assertEquals(ghosts.has('bbbb'), true);
});

Deno.test('computeGhostHashes: already-visible neighbor is not a ghost', () => {
  const blockA: BlockEdges = {
    hash: 'aaaa',
    anchor: 'bbbb',
    aggregates: [],
    refs: [],
  };
  const blockB: BlockEdges = {
    hash: 'bbbb',
    anchor: '0'.repeat(64),
    aggregates: [],
    refs: [],
  };
  const visible = new Set(['aaaa', 'bbbb']);
  const ghosts = computeGhostHashes(visible, [blockA, blockB]);
  assertEquals(ghosts.has('aaaa'), false);
  assertEquals(ghosts.has('bbbb'), false);
  assertEquals(ghosts.size, 0);
});

Deno.test('computeGhostHashes: two-hop neighbor is NOT a ghost', () => {
  // A -> B -> C chain. A is visible. B is ghost (1-hop). C should NOT be ghost (2-hop).
  const blockA: BlockEdges = {
    hash: 'aaaa',
    anchor: 'bbbb',
    aggregates: [],
    refs: [],
  };
  const blockB: BlockEdges = {
    hash: 'bbbb',
    anchor: 'cccc',
    aggregates: [],
    refs: [],
  };
  const blockC: BlockEdges = {
    hash: 'cccc',
    anchor: '0'.repeat(64),
    aggregates: [],
    refs: [],
  };
  const visible = new Set(['aaaa']);
  const ghosts = computeGhostHashes(visible, [blockA, blockB, blockC]);
  assertEquals(ghosts.has('bbbb'), true); // 1-hop ghost
  assertEquals(ghosts.has('cccc'), false); // 2-hop, not a ghost
});

Deno.test('computeGhostHashes: zero hash is never a ghost', () => {
  const zeroHash = '0'.repeat(64);
  const blockA: BlockEdges = {
    hash: 'aaaa',
    anchor: zeroHash,
    aggregates: [],
    refs: [],
  };
  const visible = new Set(['aaaa']);
  // Even if the zero hash were in allBlocks, it should not be a ghost
  const zeroBlock: BlockEdges = {
    hash: zeroHash,
    anchor: zeroHash,
    aggregates: [],
    refs: [],
  };
  const ghosts = computeGhostHashes(visible, [blockA, zeroBlock]);
  assertEquals(ghosts.has(zeroHash), false);
});

Deno.test('computeGhostHashes: block not in allBlocks is not a ghost', () => {
  // Block A references hash 'bbbb' as anchor, but no block with that hash is in allBlocks
  const blockA: BlockEdges = {
    hash: 'aaaa',
    anchor: 'bbbb',
    aggregates: [],
    refs: [],
  };
  const visible = new Set(['aaaa']);
  const ghosts = computeGhostHashes(visible, [blockA]); // blockB not in allBlocks
  assertEquals(ghosts.has('bbbb'), false);
});
