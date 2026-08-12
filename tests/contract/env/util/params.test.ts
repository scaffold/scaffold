import { assertEquals, assertThrows } from '@std/assert';
import { ParamsReader, serializeParams } from '../../../../src/contract/env/util/params.ts';

class FakeEnv {
  requests: number[] = [];

  constructor(private bytes: Uint8Array) {}

  params(truncate: number): Uint8Array {
    this.requests.push(truncate);
    return this.bytes.subarray(0, truncate);
  }
}

const reader = (bytes: Uint8Array) => {
  const env = new FakeEnv(bytes);
  return { env, reader: new ParamsReader(env) };
};

Deno.test('reads back every serialized param', () => {
  const { reader: r } = reader(serializeParams(['abc', 7, { a: [1, null] }, true]));
  assertEquals(r.read(0), 'abc');
  assertEquals(r.read(1), 7);
  assertEquals(r.read(2), { a: [1, null] });
  assertEquals(r.read(3), true);
});

Deno.test('reads params in any order and repeatedly', () => {
  const { reader: r } = reader(serializeParams(['a', 'b', 'c']));
  assertEquals(r.read(2), 'c');
  assertEquals(r.read(0), 'a');
  assertEquals(r.read(2), 'c');
});

Deno.test('reads an empty string and an empty object param', () => {
  const { reader: r } = reader(serializeParams(['', {}]));
  assertEquals(r.read(0), '');
  assertEquals(r.read(1), {});
});

Deno.test('serializes an empty param list to no bytes', () => {
  assertEquals(serializeParams([]), new Uint8Array());
});

Deno.test('serializes the same params to identical bytes', () => {
  assertEquals(serializeParams(['a', 1]), serializeParams(['a', 1]));
});

Deno.test('reads no more bytes than the requested param needs', () => {
  const params = serializeParams(['a', 'b', 'c']);
  const { env, reader: r } = reader(params);
  r.read(0);
  assertEquals(Math.max(...env.requests), 4 + 3);
  assertEquals(params.length, 3 * (4 + 3));
});

Deno.test('does not touch the env to re-read an already-read param', () => {
  const { env, reader: r } = reader(serializeParams(['a', 'b']));
  r.read(1);
  const requests = env.requests.length;
  r.read(0);
  r.read(1);
  assertEquals(env.requests.length, requests);
});

Deno.test('reads undefined when the requested param is past the end of the params', () => {
  const { reader: r } = reader(serializeParams(['a']));
  assertEquals(r.read(1), undefined);
  assertEquals(r.read(9), undefined);
  assertEquals(r.read(0), 'a');
});

Deno.test('reads undefined from empty params', () => {
  const { reader: r } = reader(serializeParams([]));
  assertEquals(r.read(0), undefined);
});

Deno.test('throws when a param body is truncated', () => {
  const { reader: r } = reader(serializeParams([12345]).subarray(0, 7));
  assertThrows(() => r.read(0), Error, 'Malformed params');
});

Deno.test('throws when a param length prefix is truncated', () => {
  const { reader: r } = reader(serializeParams(['a', 'b']).subarray(0, 4 + 3 + 2));
  assertThrows(() => r.read(1), Error, 'Malformed params');
});

Deno.test('throws when a param is not JSON', () => {
  const { reader: r } = reader(serializeParams(['a', 'b']).fill(0xff, 4, 5));
  assertThrows(() => r.read(0), SyntaxError);
});

Deno.test('throws when the index is not a non-negative integer', () => {
  const { reader: r } = reader(serializeParams(['a']));
  assertThrows(() => r.read(-1), Error, 'Invalid params index');
  assertThrows(() => r.read(0.5), Error, 'Invalid params index');
});

Deno.test('throws when a param is not JSON-serializable', () => {
  assertThrows(() => serializeParams([undefined]), Error, 'not JSON-serializable');
  assertThrows(() => serializeParams([() => {}]), Error, 'not JSON-serializable');
});
