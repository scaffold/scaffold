import { assertEquals, assertStrictEquals } from '@std/assert';
import { ForestModule } from '../src/core/ForestService.ts';

interface AggNode {
  aggregatingNodes: AggNode[];
  name: string;
}

const node = (name: string, ...aggregates: AggNode[]): AggNode => {
  const self: AggNode = { name, aggregatingNodes: [] };
  for (const child of aggregates) child.aggregatingNodes.push(self);
  return self;
};

const names = (nodes: Iterable<AggNode>): string[] => [...nodes].map((n) => n.name);

Deno.test('a lone node is its own only aggregator', () => {
  const x = node('X');

  assertEquals(names(new ForestModule().aggregators(x)), ['X']);
});

Deno.test('aggregators walks the aggregation chain transitively', () => {
  const x = node('X');
  const z = node('Z', x);
  node('W', z);

  assertEquals(names(new ForestModule().aggregators(x)), ['X', 'Z', 'W']);
});

Deno.test('competing aggregators of the same block are all returned', () => {
  const x = node('X');
  node('Z1', x);
  node('Z2', x);

  assertEquals(names(new ForestModule().aggregators(x)), ['X', 'Z1', 'Z2']);
});

Deno.test('a diamond yields each aggregator once', () => {
  const x = node('X');
  const z1 = node('Z1', x);
  const z2 = node('Z2', x);
  node('W', z1, z2);

  const result = new ForestModule().aggregators(x);
  assertEquals(result.size, 4);
  assertEquals(names(result), ['X', 'Z1', 'Z2', 'W']);
});

Deno.test('a lone node has exactly one aggregation chain', () => {
  const x = node('X');

  const chains: string[][] = [];
  for (const chain of new ForestModule().aggregationChains(x)) chains.push(names(chain));
  assertEquals(chains, [['X']]);
});

Deno.test('aggregation chains are enumerated depth first, prefixes included', () => {
  const x = node('X');
  const z1 = node('Z1', x);
  node('W', z1);
  node('Z2', x);

  const chains: string[][] = [];
  for (const chain of new ForestModule().aggregationChains(x)) chains.push(names(chain));
  assertEquals(chains, [['X'], ['X', 'Z1'], ['X', 'Z1', 'W'], ['X', 'Z2']]);
});

Deno.test('a diamond enumerates every path separately', () => {
  const x = node('X');
  const z1 = node('Z1', x);
  const z2 = node('Z2', x);
  node('W', z1, z2);

  const chains: string[][] = [];
  for (const chain of new ForestModule().aggregationChains(x)) chains.push(names(chain));
  assertEquals(chains, [
    ['X'],
    ['X', 'Z1'],
    ['X', 'Z1', 'W'],
    ['X', 'Z2'],
    ['X', 'Z2', 'W'],
  ]);
});

Deno.test('a collected chain is the same mutated array -- callers must copy', () => {
  const x = node('X');
  const z = node('Z', x);
  node('W', z);

  const collected = [...new ForestModule().aggregationChains(x)];
  assertEquals(collected.length, 3);
  assertStrictEquals(collected[1], collected[0]);
  assertStrictEquals(collected[2], collected[0]);
  // Every yield aliases the same array, which is empty again once the walk ends.
  assertEquals(collected[0], []);
});

Deno.test('the shared base array is restored after a full walk', () => {
  const x = node('X');
  const z = node('Z', x);
  node('W', z);

  const base = [node('S')];
  const chains: string[][] = [];
  for (const chain of new ForestModule().aggregationChains(x, base)) chains.push(names(chain));
  assertEquals(chains, [['S', 'X'], ['S', 'X', 'Z'], ['S', 'X', 'Z', 'W']]);
  assertEquals(names(base), ['S']);
});

Deno.test('abandoning the walk early leaves the base array mutated', () => {
  const x = node('X');
  const z = node('Z', x);
  node('W', z);

  const base: AggNode[] = [];
  for (const _ of new ForestModule().aggregationChains(x, base)) break;
  assertEquals(names(base), ['X']);
});
