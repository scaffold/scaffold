import { assertEquals, assertStrictEquals } from '@std/assert';
import { BROKEN_ANCHOR_CHAIN, ForestBase, RefNodeBase } from '../../src/logic/Forest.ts';
import { AtomType, BLOCK_REF_TYPE } from '../../src/graph/types.ts';

interface FakeNode {
  type: AtomType.Block;
  anchor?: FakeNode | RefNodeBase;
  name: string;
}

const node = (name: string, anchor?: FakeNode | RefNodeBase): FakeNode => ({
  type: AtomType.Block,
  name,
  anchor,
});

const ref = (): RefNodeBase => ({ type: BLOCK_REF_TYPE });

Deno.test('basic chain behavior', () => {
  const g = node('G');
  const a = node('A', g);
  const b = node('B', a);

  const chain = new ForestBase().anchorChain(b);
  if (chain === BROKEN_ANCHOR_CHAIN) throw new Error('unexpected break');
  assertEquals(chain.map((n) => n.name), ['B', 'A', 'G']);
});

Deno.test('a chain that hits a ref is broken', () => {
  const p = node('P', ref());
  assertEquals(new ForestBase().anchorChain(p), BROKEN_ANCHOR_CHAIN);
});

Deno.test('a ref passed directly is broken', () => {
  assertEquals(new ForestBase().anchorChain(ref()), BROKEN_ANCHOR_CHAIN);
});
