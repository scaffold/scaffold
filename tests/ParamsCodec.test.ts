// Unit tests for object-params encoding (canonical JSON) and the
// requestObjectKeys builder primitive.

import { assertEquals } from '@std/assert';
import { canonicalJson } from '../src/node/draftPublishing.ts';
import { DefaultBuilderHost } from '../src/core/DefaultBuilderHost.ts';
import type { ValueDescriptor } from '../src/contracts/Contract.ts';

const DESC: ValueDescriptor = { type: 'string' } as ValueDescriptor;

Deno.test('canonicalJson: sorts object keys recursively for stable bytes', () => {
  const a = canonicalJson({ b: 2, a: 1, nested: { y: 1, x: 2 } });
  const b = canonicalJson({ nested: { x: 2, y: 1 }, a: 1, b: 2 });
  assertEquals(a, b);
  assertEquals(a, '{"a":1,"b":2,"nested":{"x":2,"y":1}}');
});

Deno.test('canonicalJson: preserves array order', () => {
  assertEquals(canonicalJson({ tags: ['c', 'a', 'b'] }), '{"tags":["c","a","b"]}');
});

Deno.test('DefaultBuilderHost.requestObjectKeys: enumerates top-level keys', () => {
  const values = new Map<string, unknown>([
    ['name', 'World'],
    ['age', 5],
  ]);
  const host = new DefaultBuilderHost(values);
  assertEquals(host.requestObjectKeys('', DESC).sort(), ['age', 'name']);
});

Deno.test('DefaultBuilderHost.requestObjectKeys: enumerates nested keys under a path', () => {
  const values = new Map<string, unknown>([
    ['collateral.side', 'long'],
    ['collateral.amount', 5],
    ['other', 1],
  ]);
  const host = new DefaultBuilderHost(values);
  host.beginObject('collateral');
  assertEquals(host.requestObjectKeys('', DESC).sort(), ['amount', 'side']);
  host.endObject();
});
