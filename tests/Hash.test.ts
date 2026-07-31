import { assert, assertEquals, assertFalse, assertThrows } from '@std/assert';
import {
  EMPTY_HASH,
  Hash,
  HASH_BITS,
  HASH_HEX_SIZE,
  HASH_REGEX,
  HASH_SIZE,
  ZERO_HASH,
} from '../src/util/Hash.ts';
import { bin2hex, hex2bin } from '../src/util/hex.ts';
import {
  arrCompare,
  arrConcat,
  arrEquals,
  arrFromNumber,
  bin2str,
  isAscii,
  str2bin,
} from '../src/util/buffer.ts';
import { bigint2binBe, bin2bigintBe } from '../src/util/bigint.ts';

const MAX = 2n ** 256n - 1n;

const bytes = (fill: (i: number) => number) =>
  new Uint8Array(Array.from({ length: HASH_SIZE }, (_, i) => fill(i)));

const repeat = (byteHex: string) => Hash.fromHex(byteHex.repeat(HASH_SIZE));

// -- Constants --

Deno.test('Hash: size constants agree', () => {
  assertEquals(HASH_SIZE, 32);
  assertEquals(HASH_HEX_SIZE, 64);
  assertEquals(HASH_BITS, 256);
  assertEquals(ZERO_HASH.toBytes(), new Uint8Array(32));
  assertEquals(ZERO_HASH.toHex(), '0'.repeat(64));
});

Deno.test('Hash: HASH_REGEX matches exactly a 64 character hex string', () => {
  assert(HASH_REGEX.test(ZERO_HASH.toHex()));
  assert(HASH_REGEX.test(Hash.random().toHex()));
  assert(HASH_REGEX.test('A'.repeat(64)));
  assertFalse(HASH_REGEX.test('0'.repeat(63)));
  assertFalse(HASH_REGEX.test('0'.repeat(65)));
  assertFalse(HASH_REGEX.test('g'.repeat(64)));
  assertFalse(HASH_REGEX.test(''));
});

// -- Construction --

Deno.test('Hash: fromBytes rejects anything that is not 32 bytes', () => {
  assertThrows(() => Hash.fromBytes(new Uint8Array(0)));
  assertThrows(() => Hash.fromBytes(new Uint8Array(31)));
  assertThrows(() => Hash.fromBytes(new Uint8Array(33)));
  assertThrows(() => Hash.fromBytes(new Uint8Array(64)));
});

Deno.test('Hash: fromBytes/toBytes round trip', () => {
  const raw = bytes((i) => (i * 7 + 1) & 0xff);
  assertEquals(Hash.fromBytes(raw).toBytes(), raw);
});

Deno.test('Hash: fromHex/toHex round trip', () => {
  const hex = 'a3f0'.repeat(16);
  assertEquals(Hash.fromHex(hex).toHex(), hex);
  const h = Hash.random();
  assert(Hash.equals(Hash.fromHex(h.toHex()), h));
});

Deno.test('Hash: fromHex accepts uppercase and normalizes to lowercase', () => {
  const upper = 'ABCDEF01'.repeat(8);
  assertEquals(Hash.fromHex(upper).toHex(), upper.toLowerCase());
  assert(Hash.equals(Hash.fromHex(upper), Hash.fromHex(upper.toLowerCase())));
});

Deno.test('Hash: fromHex rejects malformed hex', () => {
  assertThrows(() => Hash.fromHex(''));
  assertThrows(() => Hash.fromHex('0'.repeat(63)));
  assertThrows(() => Hash.fromHex('0'.repeat(65)));
  assertThrows(() => Hash.fromHex('0'.repeat(62)));
  assertThrows(() => Hash.fromHex('0'.repeat(66)));
  assertThrows(() => Hash.fromHex('z'.repeat(64)));
  assertThrows(() => Hash.fromHex('0'.repeat(63) + ' '));
});

Deno.test('Hash: toHex encodes the bytes in order', () => {
  const raw = bytes((i) => i);
  assertEquals(Hash.fromBytes(raw).toHex(), bin2hex(raw));
  assertEquals(hex2bin(Hash.fromBytes(raw).toHex()), raw);
});

Deno.test('Hash: fromPrimitive/toPrimitive round trip', () => {
  const h = Hash.random();
  assertEquals(h.toPrimitive(), h.toHex());
  assert(Hash.equals(Hash.fromPrimitive(h.toPrimitive()), h));
});

Deno.test('Hash: composePrimitives is injective over fixed width primitives', () => {
  const a = Hash.fromBigint(1n);
  const b = Hash.fromBigint(2n);
  assertEquals(Hash.composePrimitives(a.toPrimitive(), b.toPrimitive()), a.toHex() + b.toHex());
  assert(
    Hash.composePrimitives(a.toPrimitive(), b.toPrimitive()) !==
      Hash.composePrimitives(b.toPrimitive(), a.toPrimitive()),
  );
});

Deno.test('Hash: random produces distinct 32 byte hashes', () => {
  const a = Hash.random();
  const b = Hash.random();
  assertEquals(a.toBytes().length, HASH_SIZE);
  assertFalse(Hash.equals(a, b));
  assert(Hash.equals(a, a));
});

// -- bigint conversion --

Deno.test('Hash: fromBigint lays the value out big endian', () => {
  assertEquals(Hash.fromBigint(0n).toBytes(), new Uint8Array(32));
  assertEquals(Hash.fromBigint(1n).toBytes(), bigint2binBe(1n, 32));
  assertEquals(Hash.fromBigint(2n ** 248n).toBytes(), bigint2binBe(2n ** 248n, 32));
  assertEquals(Hash.fromBigint(MAX).toBytes(), bigint2binBe(MAX, 32));
  assertEquals(Hash.fromBigint(1n).toBytes()[31], 1);
  assertEquals(Hash.fromBigint(2n ** 255n).toBytes()[0], 0x80);
});

Deno.test('Hash: fromBigint/toBigint round trip across the 64 bit word boundaries', () => {
  const values = [
    0n,
    1n,
    255n,
    256n,
    2n ** 64n - 1n,
    2n ** 64n,
    2n ** 64n + 1n,
    2n ** 128n - 1n,
    2n ** 128n,
    2n ** 192n - 1n,
    2n ** 192n,
    2n ** 255n,
    MAX,
    0x0123456789abcdeffedcba9876543210n,
  ];
  for (const v of values) {
    assertEquals(Hash.fromBigint(v).toBigint(), v, `round trip failed for ${v}`);
    assertEquals(bin2bigintBe(Hash.fromBigint(v).toBytes()), v, `layout wrong for ${v}`);
  }
});

Deno.test('Hash: toBigint reads the digest big endian', () => {
  const raw = bytes((i) => (i * 11 + 3) & 0xff);
  assertEquals(Hash.fromBytes(raw).toBigint(), bin2bigintBe(raw));
  assertEquals(ZERO_HASH.toBigint(), 0n);
  assertEquals(repeat('ff').toBigint(), MAX);
});

Deno.test('Hash: fromBigint rejects values of 2^256 or more', () => {
  assertThrows(() => Hash.fromBigint(2n ** 256n));
  assertThrows(() => Hash.fromBigint(2n ** 256n + 1n));
  assertThrows(() => Hash.fromBigint(2n ** 300n));
});

Deno.test('Hash: fromBigint rejects negative values', () => {
  assertThrows(() => Hash.fromBigint(-1n));
  assertThrows(() => Hash.fromBigint(-2n));
  assertThrows(() => Hash.fromBigint(-(2n ** 255n)));
  assertThrows(() => Hash.fromBigint(-(2n ** 256n)));
  assertThrows(() => Hash.fromBigint(-(2n ** 300n)));
});

Deno.test('toBigint respects the digest view offset', () => {
  const backing = new Uint8Array(64).fill(0xaa);
  const raw = bytes((i) => i + 1);
  backing.set(raw, 16);
  const view = Hash.fromBytes(backing.subarray(16, 48));
  const copy = Hash.fromBytes(raw);

  assertEquals(view.toHex(), copy.toHex());
  assertEquals(view.toBigint(), bin2bigintBe(raw));
  assertEquals(view.toBigint(), copy.toBigint());
  assert(Hash.equals(Hash.fromBigint(view.toBigint()), view));
});

Deno.test('Hash: toBigint on a view starting at offset zero', () => {
  const backing = new Uint8Array(64).fill(0xaa);
  const raw = bytes((i) => i + 1);
  backing.set(raw, 0);
  assertEquals(Hash.fromBytes(backing.subarray(0, 32)).toBigint(), bin2bigintBe(raw));
});

// -- digest --

Deno.test('Hash: digest is SHA3-256', () => {
  assertEquals(
    Hash.digest('').toHex(),
    'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a',
  );
  assertEquals(
    Hash.digest('abc').toHex(),
    '3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532',
  );
  assertEquals(EMPTY_HASH.toHex(), Hash.digest('').toHex());
});

Deno.test('Hash: digest of a string equals digest of its utf8 bytes', () => {
  assert(Hash.equals(Hash.digest('hello'), Hash.digest(str2bin('hello'))));
  assert(Hash.equals(Hash.digest('\u00e9'), Hash.digest(str2bin('\u00e9'))));
});

Deno.test('Hash: digest is deterministic and input sensitive', () => {
  assert(Hash.equals(Hash.digest('scaffold'), Hash.digest('scaffold')));
  assertFalse(Hash.equals(Hash.digest('scaffold'), Hash.digest('scaffolD')));
  assertFalse(Hash.equals(Hash.digest(new Uint8Array([0])), Hash.digest(new Uint8Array([0, 0]))));
});

Deno.test('Hash: digest reads only the given view of a buffer', () => {
  const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
  assert(Hash.equals(
    Hash.digest(backing.subarray(2, 5)),
    Hash.digest(new Uint8Array([1, 2, 3])),
  ));
});

Deno.test('Hash: combine is deterministic and order sensitive', () => {
  const a = Hash.digest('a');
  const b = Hash.digest('b');
  assert(Hash.equals(Hash.combine(a, b), Hash.combine(a, b)));
  assertFalse(Hash.equals(Hash.combine(a, b), Hash.combine(b, a)));
  assert(Hash.equals(Hash.combine(a, b), Hash.digest(arrConcat(a.toBytes(), b.toBytes()))));
  assert(Hash.equals(Hash.combine(), EMPTY_HASH));
});

Deno.test('Hash: digestParts is deterministic and order sensitive', () => {
  const a = Hash.digest('a');
  assert(Hash.equals(Hash.digestParts(a, 1, 'x'), Hash.digestParts(a, 1, 'x')));
  assertFalse(Hash.equals(Hash.digestParts(a, 1, 'x'), Hash.digestParts(a, 2, 'x')));
  assertFalse(Hash.equals(Hash.digestParts(a, 1, 'x'), Hash.digestParts('x', 1, a)));
  assert(Hash.equals(Hash.digestParts(), EMPTY_HASH));
});

// -- Literals --

Deno.test('Hash: fromLiteral32 sign extends a 32 bit value to 256 bits', () => {
  const cases = [0, 1, 2, 0x01020304, 0x7fffffff, -1, -2, -0x80000000, 1 << 30];
  for (const n of cases) {
    assertEquals(
      Hash.fromLiteral32(n).toHex(),
      Hash.fromBigint(BigInt.asUintN(256, BigInt(n | 0))).toHex(),
      `fromLiteral32(${n})`,
    );
  }
});

Deno.test('Hash: fromLiteral32 known layouts', () => {
  assert(Hash.equals(Hash.fromLiteral32(0), ZERO_HASH));
  assertEquals(Hash.fromLiteral32(0x01020304).toHex(), '0'.repeat(56) + '01020304');
  assertEquals(Hash.fromLiteral32(-1).toHex(), 'f'.repeat(64));
  assertEquals(Hash.fromLiteral32(-2).toHex(), 'f'.repeat(62) + 'fe');
  assertEquals(Hash.fromLiteral32(-0x80000000).toHex(), 'f'.repeat(56) + '80000000');
});

Deno.test('Hash: fromLiteralStr right aligns the string in 32 bytes', () => {
  assert(Hash.equals(Hash.fromLiteralStr(''), ZERO_HASH));
  assertEquals(Hash.fromLiteralStr('abc').toBytes().slice(29), str2bin('abc'));
  assertEquals(Hash.fromLiteralStr('abc').toBytes().slice(0, 29), new Uint8Array(29));
  assertEquals(Hash.fromLiteralStr('x'.repeat(32)).toBytes(), str2bin('x'.repeat(32)));
  assertFalse(Hash.equals(Hash.fromLiteralStr('a'), Hash.fromLiteralStr('b')));
});

Deno.test('Hash: fromLiteralStr rejects over-length strings', () => {
  assertThrows(() => Hash.fromLiteralStr('x'.repeat(33)));
  assertThrows(() => Hash.fromLiteralStr('x'.repeat(64)));
});

// The length guard counts utf16 code units, so a string of 32 characters that encodes to more
// than 32 bytes is rejected by the constructor instead.
Deno.test('Hash: fromLiteralStr rejects strings whose utf8 encoding exceeds 32 bytes', () => {
  assertThrows(() => Hash.fromLiteralStr('\u00e9'.repeat(32)));
});

// -- Comparison --

Deno.test('Hash: equals compares by content', () => {
  const raw = bytes((i) => i);
  const a = Hash.fromBytes(raw);
  assert(Hash.equals(a, a));
  assert(Hash.equals(a, Hash.fromBytes(bytes((i) => i))));
  assertFalse(Hash.equals(a, Hash.fromBytes(bytes((i) => (i === 0 ? 0xff : i)))));
  assertFalse(Hash.equals(a, Hash.fromBytes(bytes((i) => (i === 31 ? 0xff : i)))));
  assertFalse(Hash.equals(ZERO_HASH, Hash.fromBigint(1n)));
});

Deno.test('Hash: compare orders by numeric value', () => {
  const pairs: [bigint, bigint][] = [
    [0n, 1n],
    [1n, 2n],
    [255n, 256n],
    [2n ** 64n - 1n, 2n ** 64n],
    [2n ** 248n, 2n ** 255n],
    [MAX - 1n, MAX],
  ];
  for (const [lo, hi] of pairs) {
    assertEquals(Hash.compare(Hash.fromBigint(lo), Hash.fromBigint(hi)), -1, `${lo} < ${hi}`);
    assertEquals(Hash.compare(Hash.fromBigint(hi), Hash.fromBigint(lo)), 1, `${hi} > ${lo}`);
  }
  assertEquals(Hash.compare(Hash.fromBigint(7n), Hash.fromBigint(7n)), 0);
});

Deno.test('Hash: compare sorts consistently with toBigint', () => {
  const values = [5n, 0n, MAX, 2n ** 128n, 1n, 2n ** 64n];
  const sorted = values.map(Hash.fromBigint).sort(Hash.compare).map((h) => h.toBigint());
  assertEquals(sorted, [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
});

// -- Arithmetic --

Deno.test('Hash: xor is an involution with zero as identity', () => {
  const a = Hash.random();
  const b = Hash.random();
  assert(Hash.equals(Hash.xor(a, ZERO_HASH), a));
  assert(Hash.equals(Hash.xor(a, a), ZERO_HASH));
  assert(Hash.equals(Hash.xor(Hash.xor(a, b), b), a));
  assert(Hash.equals(Hash.xor(a, b), Hash.xor(b, a)));
  assert(Hash.equals(Hash.xor(repeat('ff'), repeat('0f')), repeat('f0')));
  assert(Hash.equals(Hash.xor(ZERO_HASH, repeat('ff')), repeat('ff')));
});

Deno.test('Hash: add with zero and without carries', () => {
  const a = Hash.random();
  assert(Hash.equals(Hash.add(a, ZERO_HASH), a));
  assert(Hash.equals(Hash.add(ZERO_HASH, a), a));
  // Disjoint bits never carry, so the sum must equal the xor.
  assert(Hash.equals(Hash.add(repeat('f0'), repeat('0f')), Hash.xor(repeat('f0'), repeat('0f'))));
  assert(Hash.equals(Hash.add(repeat('f0'), repeat('0f')), repeat('ff')));
  assert(Hash.equals(Hash.add(a, ZERO_HASH), Hash.xor(a, ZERO_HASH)));
});

Deno.test('add agrees with the numeric value of the hash', () => {
  const one = Hash.fromBigint(1n);
  assertEquals(Hash.add(Hash.fromBigint(255n), one).toBigint(), 256n);
  assertEquals(Hash.add(Hash.fromBigint(2n ** 64n - 1n), one).toBigint(), 2n ** 64n);
  assertEquals(Hash.add(Hash.fromBigint(7n), Hash.fromBigint(9n)).toBigint(), 16n);
  assert(Hash.equals(Hash.add(Hash.fromBigint(255n), one), Hash.fromBigint(255n).increment()));
  // Full width overflow wraps modulo 2^256.
  assert(Hash.equals(Hash.add(Hash.fromBigint(MAX), one), ZERO_HASH));
});

Deno.test('Hash: increment adds one to the numeric value', () => {
  assert(Hash.equals(ZERO_HASH.increment(), Hash.fromBigint(1n)));
  assert(Hash.equals(Hash.fromBigint(1n).increment(), Hash.fromBigint(2n)));
  assert(Hash.equals(Hash.fromBigint(255n).increment(), Hash.fromBigint(256n)));
  assert(Hash.equals(Hash.fromBigint(2n ** 64n - 1n).increment(), Hash.fromBigint(2n ** 64n)));
  assert(Hash.equals(Hash.fromBigint(2n ** 255n).increment(), Hash.fromBigint(2n ** 255n + 1n)));
});

Deno.test('Hash: increment wraps around at the maximum', () => {
  assert(Hash.equals(Hash.fromBigint(MAX).increment(), ZERO_HASH));
  assert(Hash.equals(repeat('ff').increment(), ZERO_HASH));
});

Deno.test('Hash: increment does not mutate the receiver', () => {
  const a = Hash.fromBigint(255n);
  a.increment();
  assertEquals(a.toBigint(), 255n);
});

// -- Bits --

Deno.test('Hash: population counts set bits', () => {
  assertEquals(ZERO_HASH.population(), 0);
  assertEquals(repeat('ff').population(), 256);
  assertEquals(repeat('0f').population(), 128);
  assertEquals(repeat('01').population(), 32);
  assertEquals(Hash.fromBigint(1n).population(), 1);
  assertEquals(Hash.fromBigint(2n ** 255n).population(), 1);
  assertEquals(Hash.fromBigint(MAX).population(), 256);
});

Deno.test('Hash: bit reads every one of the 256 bits', () => {
  const ones = repeat('ff');
  for (let i = 0; i < HASH_BITS; i++) {
    assertEquals(ZERO_HASH.bit(i), 0, `zero bit ${i}`);
    assertEquals(ones.bit(i), 1, `ones bit ${i}`);
  }
  const h = Hash.random();
  let set = 0;
  for (let i = 0; i < HASH_BITS; i++) {
    const b = h.bit(i);
    assert(b === 0 || b === 1, `bit ${i} is not a bit`);
    set += b;
  }
  assertEquals(set, h.population());
});

// bit() indexes the byte stream (bytes ascending, least significant bit first within each byte),
// which is not the numeric bit order that fromBigint defines: the value 1 lives in byte 31.
Deno.test('Hash: bit indexes the byte stream rather than the numeric value', () => {
  assertEquals(Hash.fromBigint(1n).bit(248), 1);
  assertEquals(Hash.fromBigint(1n).bit(0), 0);
  assertEquals(Hash.fromBigint(2n ** 255n).bit(7), 1);
});

Deno.test('countLeadingZeros counts from the most significant bit', () => {
  assertEquals(Hash.fromBigint(2n ** 255n).countLeadingZeros(), 0);
  assertEquals(Hash.fromBigint(MAX).countLeadingZeros(), 0);
  assertEquals(Hash.fromBigint(1n).countLeadingZeros(), 255);
  assertEquals(Hash.fromBigint(2n ** 248n).countLeadingZeros(), 7);

  const big = Hash.fromBigint(2n ** 255n);
  const small = Hash.fromBigint(2n ** 248n);
  assertEquals(Hash.compare(big, small), 1);
  assert(big.countLeadingZeros() < small.countLeadingZeros());
});

Deno.test('Hash: countLeadingZeros of zero covers every bit', () => {
  assertEquals(ZERO_HASH.countLeadingZeros(), HASH_BITS);
  assertEquals(repeat('ff').countLeadingZeros(), 0);
});

Deno.test('Hash: weightedPopulation with a flat weight is a scaled population', () => {
  assertEquals(ZERO_HASH.weightedPopulation(0, 256), 0);
  assertEquals(ZERO_HASH.weightedPopulation(5, 5), 0);
  assertEquals(repeat('0f').weightedPopulation(1, 1), repeat('0f').population());
  assertEquals(repeat('ff').weightedPopulation(3, 3), 3 * 256);
  assertEquals(Hash.fromBigint(1n).weightedPopulation(2, 2), 2);
});

Deno.test('Hash: weightedPopulation ramps the weight across the bits', () => {
  // Every bit set, weights 0, 1, ... 255: the arithmetic series 255 * 256 / 2.
  assertEquals(repeat('ff').weightedPopulation(0, 256), 32640);
  assertEquals(repeat('ff').weightedPopulation(1, 257), 32640 + 256);
});

// -- Aliasing --

// Hash keeps the array it was handed and caches the hex at construction, so mutating the source
// afterwards leaves toHex and toBytes reporting different hashes.
Deno.test('Hash: mutating the source array desynchronizes toHex from toBytes', () => {
  const raw = new Uint8Array(32);
  const h = Hash.fromBytes(raw);
  assertEquals(h.toHex(), '0'.repeat(64));

  raw[0] = 0xff;
  assertEquals(h.toBytes()[0], 0xff);
  assertEquals(h.toHex(), '0'.repeat(64));
  assertFalse(Hash.equals(h, Hash.fromHex(h.toHex())));
});

// -- fromFraction --

Deno.test('Hash: fromFraction maps a fraction onto the 256 bit range', () => {
  assert(Hash.equals(Hash.fromFraction(0, 1), ZERO_HASH));
  assertEquals(Hash.fromFraction(1, 2).toBigint(), 2n ** 255n);
  assertEquals(Hash.fromFraction(1, 4).toBigint(), 2n ** 254n);
  assertEquals(Hash.fromFraction(3, 4).toBigint(), 3n * 2n ** 254n);
  assertEquals(Hash.fromFraction(1, 256).toBigint(), 2n ** 248n);
});

Deno.test('Hash: fromFraction saturates at or above one', () => {
  assert(Hash.equals(Hash.fromFraction(1, 1), repeat('ff')));
  assert(Hash.equals(Hash.fromFraction(5, 4), repeat('ff')));
  assert(Hash.equals(Hash.fromFraction(2, 1), repeat('ff')));
});

Deno.test('Hash: fromFraction approximates non-dyadic fractions', () => {
  const third = Hash.fromFraction(1, 3);
  assertEquals(third.toBytes()[0], 0x55);
  assertEquals(third.toBytes()[1], 0x55);
  assertEquals(Hash.compare(third, Hash.fromFraction(1, 2)), -1);
  assertEquals(Hash.compare(third, Hash.fromFraction(1, 4)), 1);
});

Deno.test('fromFraction handles fractions below the resolution of a hash', () => {
  const tiny = Hash.fromFraction(1, 1e100);
  assertEquals(Hash.compare(tiny, Hash.fromBigint(1n)) <= 0, true);
});

// -- hex.ts --

Deno.test('hex: bin2hex/hex2bin round trip', () => {
  const cases = [
    new Uint8Array(),
    new Uint8Array([0]),
    new Uint8Array([255]),
    new Uint8Array([0, 1, 254, 255]),
    new Uint8Array(Array.from({ length: 256 }, (_, i) => i)),
  ];
  for (const c of cases) {
    assertEquals(hex2bin(bin2hex(c)), c);
  }
});

Deno.test('hex: bin2hex emits lowercase zero padded bytes', () => {
  assertEquals(bin2hex(new Uint8Array()), '');
  assertEquals(bin2hex(new Uint8Array([0])), '00');
  assertEquals(bin2hex(new Uint8Array([1, 15, 16, 171, 255])), '010f10abff');
});

Deno.test('hex: hex2bin decodes both cases', () => {
  assertEquals(hex2bin(''), new Uint8Array());
  assertEquals(hex2bin('00ff'), new Uint8Array([0, 255]));
  assertEquals(hex2bin('ABCDEF'), hex2bin('abcdef'));
});

Deno.test('hex: hex2bin rejects odd lengths and non hex characters', () => {
  assertThrows(() => hex2bin('a'));
  assertThrows(() => hex2bin('abc'));
  assertThrows(() => hex2bin('zz'));
  assertThrows(() => hex2bin('0g'));
  assertThrows(() => hex2bin('00 ff'));
  assertThrows(() => hex2bin('0x00'));
});

Deno.test('hex: bin2hex encodes only the given view', () => {
  const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
  assertEquals(bin2hex(backing.subarray(2, 5)), '010203');
});

// -- buffer.ts --

Deno.test('buffer: str2bin/bin2str round trip', () => {
  for (const s of ['', 'hello', 'scaffold', '\u00e9', '\u4e16\u754c', '\u{1f600}']) {
    assertEquals(bin2str(str2bin(s)), s);
  }
  assertEquals(str2bin('abc'), new Uint8Array([97, 98, 99]));
  assertEquals(str2bin('\u00e9'), new Uint8Array([0xc3, 0xa9]));
  assertEquals(str2bin('').length, 0);
});

// bin2str memoizes on the array instance, so a mutated array keeps its first decoding.
Deno.test('buffer: bin2str memoizes by array identity', () => {
  const arr = str2bin('abc');
  assertEquals(bin2str(arr), 'abc');
  arr[0] = 122;
  assertEquals(bin2str(arr), 'abc');
  assertEquals(bin2str(arr.slice()), 'zbc');
});

Deno.test('buffer: arrConcat joins in order', () => {
  assertEquals(arrConcat(), new Uint8Array());
  assertEquals(arrConcat(new Uint8Array([1, 2])), new Uint8Array([1, 2]));
  assertEquals(
    arrConcat(new Uint8Array([1]), new Uint8Array(), new Uint8Array([2, 3])),
    new Uint8Array([1, 2, 3]),
  );
});

Deno.test('buffer: arrConcat copies its inputs', () => {
  const a = new Uint8Array([1, 2]);
  const out = arrConcat(a, new Uint8Array([3]));
  a[0] = 9;
  assertEquals(out, new Uint8Array([1, 2, 3]));
});

Deno.test('buffer: arrEquals compares content', () => {
  const a = new Uint8Array([1, 2, 3]);
  assert(arrEquals(a, a));
  assert(arrEquals(a, new Uint8Array([1, 2, 3])));
  assert(arrEquals(new Uint8Array(), new Uint8Array()));
  assertFalse(arrEquals(a, new Uint8Array([1, 2])));
  assertFalse(arrEquals(a, new Uint8Array([1, 2, 3, 4])));
  assertFalse(arrEquals(a, new Uint8Array([1, 2, 4])));
  assert(arrEquals(a, new Uint8Array([9, 1, 2, 3]).subarray(1)));
});

Deno.test('buffer: arrCompare orders lexicographically with shorter prefixes first', () => {
  assertEquals(arrCompare(new Uint8Array([1]), new Uint8Array([2])), -1);
  assertEquals(arrCompare(new Uint8Array([2]), new Uint8Array([1])), 1);
  assertEquals(arrCompare(new Uint8Array([1, 2]), new Uint8Array([1, 2])), 0);
  assertEquals(arrCompare(new Uint8Array([1]), new Uint8Array([1, 0])), -1);
  assertEquals(arrCompare(new Uint8Array([1, 0]), new Uint8Array([1])), 1);
  assertEquals(arrCompare(new Uint8Array(), new Uint8Array()), 0);
  assertEquals(arrCompare(new Uint8Array(), new Uint8Array([0])), -1);
});

Deno.test('buffer: arrFromNumber encodes little endian', () => {
  assertEquals(arrFromNumber(0, 4), new Uint8Array([0, 0, 0, 0]));
  assertEquals(arrFromNumber(1, 4), new Uint8Array([1, 0, 0, 0]));
  assertEquals(arrFromNumber(0x1234, 2), new Uint8Array([0x34, 0x12]));
  assertEquals(arrFromNumber(0x1234, 4), new Uint8Array([0x34, 0x12, 0, 0]));
  assertEquals(arrFromNumber(255, 1), new Uint8Array([255]));
  assertEquals(arrFromNumber(0, 0), new Uint8Array());
  assertEquals(arrFromNumber(0x7fffffff, 4), new Uint8Array([0xff, 0xff, 0xff, 0x7f]));
  assertEquals(arrFromNumber(2 ** 31, 4), new Uint8Array([0, 0, 0, 0x80]));
  assertEquals(arrFromNumber(2 ** 32 - 1, 4), new Uint8Array([0xff, 0xff, 0xff, 0xff]));
});

Deno.test('buffer: arrFromNumber truncates to the requested width', () => {
  assertEquals(arrFromNumber(0x1234, 1), new Uint8Array([0x34]));
  assertEquals(arrFromNumber(-1, 4), new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  assertEquals(arrFromNumber(-2, 2), new Uint8Array([0xfe, 0xff]));
});

Deno.test('buffer: isAscii covers the printable range', () => {
  assert(isAscii(new Uint8Array()));
  assert(isAscii(str2bin('hello world')));
  assert(isAscii(new Uint8Array([32, 126])));
  assertFalse(isAscii(new Uint8Array([31])));
  assertFalse(isAscii(new Uint8Array([127])));
  assertFalse(isAscii(new Uint8Array([0])));
  assertFalse(isAscii(str2bin('\u00e9')));
});
