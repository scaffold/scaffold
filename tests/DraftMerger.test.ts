import { assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { draftsAreMergeable } from '../src/core/Draft.ts';

const h = (s: string) => Hash.digest(s);

Deno.test('drafts disjoint namespaces: mergeable', () => {
  const a = [h('A')];
  const b = [h('B')];
  assertEquals(draftsAreMergeable(a, b), true);
});

Deno.test('drafts empty namespaces: mergeable', () => {
  assertEquals(draftsAreMergeable([], []), true);
});

Deno.test('drafts overlapping namespaces: not mergeable', () => {
  const shared = h('SIGNATURE');
  const a = [shared];
  const b = [shared];
  assertEquals(draftsAreMergeable(a, b), false);
});

Deno.test('drafts partial overlap: not mergeable', () => {
  const a = [h('A'), h('SHARED')];
  const b = [h('B'), h('SHARED')];
  assertEquals(draftsAreMergeable(a, b), false);
});
