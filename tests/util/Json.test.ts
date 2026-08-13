import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
  assertThrows,
} from '@std/assert';
import { jsonSafeStringify, taggedParse, taggedStringify } from '../../src/util/json.ts';
import { Hash } from '../../src/util/Hash.ts';
import { range } from '../../src/util/functional.ts';

const roundTrip = (val: unknown) => taggedParse(taggedStringify(val));

// -- bigint --

Deno.test('taggedJson: bigint round trip', () => {
  assertEquals(roundTrip(0n), 0n);
  assertEquals(roundTrip(1n), 1n);
  assertEquals(roundTrip(-1n), -1n);
  assertEquals(roundTrip(-999999n), -999999n);
});

Deno.test('taggedJson: bigint survives beyond Number.MAX_SAFE_INTEGER', () => {
  const big = BigInt(Number.MAX_SAFE_INTEGER) * 1000n + 7n;
  assertEquals(roundTrip(big), big);
  assertEquals(roundTrip(-big), -big);

  // A 256-bit value -- the largest thing a Hash-sized integer can be.
  const huge = (1n << 256n) - 1n;
  assertEquals(roundTrip(huge), huge);
});

Deno.test('taggedJson: bigint stays a bigint, never a number', () => {
  assertEquals(typeof roundTrip(5n), 'bigint');
  assertEquals(typeof roundTrip(5), 'number');
  assertNotEquals(roundTrip(5n), roundTrip(5) as unknown);
});

// -- Uint8Array --

Deno.test('taggedJson: Uint8Array round trip', () => {
  const cases = [
    new Uint8Array(),
    new Uint8Array([0]),
    new Uint8Array([0, 0, 0]),
    new Uint8Array([255, 254, 128, 127, 1, 0]),
    new Uint8Array(range(256)),
  ];
  for (const bin of cases) {
    const out = roundTrip(bin);
    assert(out instanceof Uint8Array, 'decoded bytes must be a real Uint8Array');
    assertEquals(out, bin);
  }
});

Deno.test('taggedJson: Uint8Array view encodes only its own window', () => {
  const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
  const view = backing.subarray(2, 5);
  assertEquals(roundTrip(view), new Uint8Array([1, 2, 3]));
});

Deno.test('taggedJson: decoded bytes do not alias the input', () => {
  const bin = new Uint8Array([1, 2, 3]);
  const out = roundTrip(bin) as Uint8Array;
  out[0] = 99;
  assertEquals(bin[0], 1);
});

// -- Hash --

Deno.test('taggedJson: Hash round trip', () => {
  for (const h of [Hash.digest('a'), Hash.fromBytes(new Uint8Array(32)), Hash.random()]) {
    const out = roundTrip(h);
    assert(out instanceof Hash, 'decoded hash must be a real Hash');
    assert(Hash.equals(out, h));
    assertEquals(out.toHex(), h.toHex());
  }
});

Deno.test('taggedJson: Hash and Uint8Array are not confused', () => {
  const h = Hash.digest('a');
  assert(!(roundTrip(h.toBytes()) instanceof Hash));
  assert(roundTrip(h) instanceof Hash);
});

// -- structure --

Deno.test('taggedJson: tagged values survive nesting', () => {
  const val = {
    hashes: [Hash.digest('a'), Hash.digest('b')],
    nested: { deep: { bytes: new Uint8Array([7, 8]), n: 42n } },
    mixed: [1n, new Uint8Array([1]), Hash.digest('c'), 'plain', 3, true, null],
  };
  const out = roundTrip(val) as typeof val;
  assert(Hash.equals(out.hashes[1], val.hashes[1]));
  assertEquals(out.nested.deep.bytes, new Uint8Array([7, 8]));
  assertEquals(out.nested.deep.n, 42n);
  assertEquals(out.mixed[0], 1n);
  assert(out.mixed[2] instanceof Hash);
  assertEquals(out.mixed.slice(3), ['plain', 3, true, null]);
});

Deno.test('taggedJson: ordinary JSON types survive', () => {
  const val = {
    nul: null,
    t: true,
    f: false,
    zero: 0,
    neg: -1.5,
    empty: '',
    emptyObj: {},
    emptyArr: [],
    nestedEmpty: [{}, [], [[]]],
    escapes: '\u00e9\u2603 \t\n"\\',
  };
  assertEquals(roundTrip(val), val);
});

Deno.test('taggedJson: a tagged value at the document root is revived', () => {
  assertEquals(taggedParse('{"__t":"N","v":"7"}'), 7n);
  assert(taggedParse(taggedStringify(Hash.digest('x'))) instanceof Hash);
  assertEquals(taggedParse(taggedStringify(new Uint8Array([1]))), new Uint8Array([1]));
});

// -- value stability, not byte stability (TODO.v2.md) --

Deno.test('taggedJson: re-encoding a decoded payload can change the bytes', () => {
  // Whitespace and key order are not recovered by the decoder, so `raw` -- not a
  // re-encode of the decoded payload -- is the only source of block identity.
  const spaced = '{ "a": {"__t":"N","v":"1"} }';
  assertEquals(taggedStringify(taggedParse(spaced)), '{"a":{"__t":"N","v":"1"}}');
  assertNotEquals(taggedStringify(taggedParse(spaced)), spaced);

  const numericKeys = '{"2":"b","1":"a"}';
  assertEquals(taggedStringify(taggedParse(numericKeys)), '{"1":"a","2":"b"}');
});

Deno.test('taggedJson: re-encoding preserves the decoded value', () => {
  const val = { a: 1n, b: new Uint8Array([1, 2]), c: Hash.digest('z') };
  const once = taggedStringify(val);
  const twice = taggedStringify(taggedParse(once));
  assertEquals(taggedParse(twice), taggedParse(once));
});

// -- adversarial input --

Deno.test('taggedJson: a forged tag object is decoded as a real tagged value', () => {
  // The encoding is not injective: a plain object shaped like the tag envelope
  // encodes identically to a genuine tagged value, so the round trip loses it.
  const forgedHash = { __t: 'H', v: '00'.repeat(32) };
  assert(roundTrip(forgedHash) instanceof Hash);

  const forgedBytes = { __t: 'B', v: 'AQID' };
  assertEquals(roundTrip(forgedBytes), new Uint8Array([1, 2, 3]));

  const forgedBigint = { __t: 'N', v: '5' };
  assertEquals(roundTrip(forgedBigint), 5n);
});

Deno.test('taggedJson: a forged tag nested in untrusted JSON is revived', () => {
  const hostile = '{"outputs":[{"amount":{"__t":"N","v":"1"},"params":{"__t":"B","v":"AA=="}}]}';
  const out = taggedParse(hostile) as { outputs: { amount: bigint; params: Uint8Array }[] };
  assertEquals(out.outputs[0].amount, 1n);
  assertEquals(out.outputs[0].params, new Uint8Array([0]));
});

Deno.test('taggedJson: an unknown tag throws', () => {
  assertThrows(() => taggedParse('{"__t":"Z","v":"x"}'), Error, `Unknown type tag 'Z'!`);
  assertThrows(() => taggedParse('{"__t":null,"v":"x"}'), Error, 'Unknown type tag');
  assertThrows(() => taggedParse('{"__t":"","v":"x"}'), Error, 'Unknown type tag');
});

Deno.test('taggedJson: a non-string tag body throws', () => {
  assertThrows(() => taggedParse('{"__t":"N","v":5}'), Error, 'has a non-string body');
  assertThrows(() => taggedParse('{"__t":"N"}'), Error, 'has a non-string body');
  assertThrows(() => taggedParse('{"__t":"B","v":null}'), Error, 'has a non-string body');
  assertThrows(() => taggedParse('{"__t":"H","v":["a"]}'), Error, 'has a non-string body');
});

Deno.test('taggedJson: a malformed tag body throws', () => {
  assertThrows(() => taggedParse('{"__t":"H","v":"00"}'), Error, 'Invalid digest length');
  assertThrows(() => taggedParse(`{"__t":"H","v":"${'z'.repeat(64)}"}`), TypeError);
  assertThrows(() => taggedParse('{"__t":"B","v":"!!!!"}'), TypeError);
  assertThrows(() => taggedParse('{"__t":"N","v":"1.5"}'), SyntaxError);
});

Deno.test('taggedJson: any plain object carrying a __t key is hijacked or rejected', () => {
  // A payload field literally named `__t` cannot survive the codec at all.
  assertThrows(() => roundTrip({ __t: 'user data', v: 'x' }), Error, 'Unknown type tag');
  assertThrows(() => roundTrip({ __t: 1, other: true }), Error, 'has a non-string body');
});

Deno.test('taggedJson: the decoder accepts non-canonical tag bodies', () => {
  // Several distinct encodings decode to the same value, so wire bytes are not
  // recoverable from the decoded value.
  assertEquals(taggedParse('{"__t":"N","v":"0x10"}'), 16n);
  assertEquals(taggedParse('{"__t":"N","v":""}'), 0n);
  assertEquals(taggedParse('{"__t":"N","v":"  8 "}'), 8n);
  assertEquals(taggedParse('{"__t":"B","v":"QQ"}'), new Uint8Array([65]));
  assertEquals(taggedParse('{"__t":"B","v":"QQ=="}'), new Uint8Array([65]));
  assertEquals(
    (taggedParse(`{"__t":"H","v":"${'AB'.repeat(32)}"}`) as Hash).toHex(),
    'ab'.repeat(32),
  );
});

Deno.test('taggedJson: extra keys alongside a tag are ignored', () => {
  assertEquals(taggedParse('{"__t":"N","v":"7","junk":1}'), 7n);
});

Deno.test('taggedJson: malformed JSON throws', () => {
  assertThrows(() => taggedParse('{'), SyntaxError);
  assertThrows(() => taggedParse(''), SyntaxError);
});

// -- non-JSON values --

Deno.test('taggedJson: undefined, functions and symbols are dropped from objects', () => {
  assertEquals(taggedStringify({ a: 1, u: undefined, f: () => {}, s: Symbol('x') }), '{"a":1}');
});

Deno.test('taggedJson: undefined, functions and symbols become null in arrays', () => {
  assertEquals(taggedStringify([undefined, () => {}, Symbol('x'), 1]), '[null,null,null,1]');
});

Deno.test('taggedJson: taggedStringify returns undefined for unrepresentable roots', () => {
  // The declared return type is `string`, but JSON.stringify yields undefined here.
  assertEquals(taggedStringify(undefined) as unknown, undefined);
  assertEquals(taggedStringify(() => {}) as unknown, undefined);
  assertEquals(taggedStringify(Symbol('x')) as unknown, undefined);
});

Deno.test('taggedJson: NaN and Infinity collapse to null', () => {
  assertEquals(
    taggedStringify({ a: NaN, b: Infinity, c: -Infinity }),
    '{"a":null,"b":null,"c":null}',
  );
});

Deno.test('taggedJson: unsupported containers stringify as empty objects', () => {
  assertEquals(taggedStringify(new Map([['a', 1]])), '{}');
  assertEquals(taggedStringify(new Set([1])), '{}');
});

Deno.test('taggedJson: a circular structure throws', () => {
  const a: Record<string, unknown> = {};
  a.self = a;
  assertThrows(() => taggedStringify(a), TypeError);
});

// -- jsonSafeStringify --

Deno.test('jsonSafeStringify: bigints become decimal strings', () => {
  assertEquals(jsonSafeStringify({ a: 1n, b: -2n }), '{"a":"1","b":"-2"}');
});

Deno.test('jsonSafeStringify: a Hash becomes its hex', () => {
  const h = Hash.digest('a');
  assertEquals(jsonSafeStringify(h), JSON.stringify(h.toHex()));
  assertEquals(jsonSafeStringify({ x: h }), `{"x":"${h.toHex()}"}`);
});

Deno.test('jsonSafeStringify: an object with a `hash` field is reduced to that hash', () => {
  const h = Hash.digest('a');
  assertEquals(jsonSafeStringify({ hash: h, dropped: 1 }), `{"hash":"${h.toHex()}"}`);
});

Deno.test('jsonSafeStringify: a Uint8Array becomes its hex', () => {
  assertEquals(jsonSafeStringify({ b: new Uint8Array([0x4a, 0x6f]) }), '{"b":"4a6f"}');
});

Deno.test('jsonSafeStringify: an empty Uint8Array becomes an empty string', () => {
  assertEquals(jsonSafeStringify({ b: new Uint8Array() }), '{"b":""}');
});

Deno.test('jsonSafeStringify: circular references become [circular]', () => {
  const a: Record<string, unknown> = { name: 'a' };
  a.self = a;
  assertStringIncludes(jsonSafeStringify(a), '[circular]');
});

Deno.test('jsonSafeStringify: repeated siblings are not treated as circular', () => {
  const shared = { v: 1 };
  assertEquals(jsonSafeStringify({ a: shared, b: shared }), '{"a":{"v":1},"b":{"v":1}}');
});

Deno.test('jsonSafeStringify: honours the space argument', () => {
  assertStringIncludes(jsonSafeStringify({ a: 1 }, 2), '\n  "a": 1');
});

Deno.test('jsonSafeStringify: nulls and primitives pass through', () => {
  assertEquals(
    jsonSafeStringify({ a: null, b: true, c: 'x', d: 1 }),
    '{"a":null,"b":true,"c":"x","d":1}',
  );
});
