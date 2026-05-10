import { assertEquals, assertThrows } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import type { Output, Verifier } from '../src/core/BlockCreationModule.ts';
import type { Claim } from '../src/core/ContractEnv.ts';
import {
  decodeOutput,
  decodeOutputList,
  decodeVerifier,
  encodeClaim,
  encodeClaimList,
  encodeOutput,
  encodeValueAndBody,
  encodeVerifier,
  packPtrLen,
  readI128,
  unpackPtrLen,
  writeI128,
} from '../src/plugins/wasm/WasmWireCodec.ts';

const enc = (s: string) => new TextEncoder().encode(s);

// -- packed (ptr, len) i64 --------------------------------------

Deno.test('packPtrLen + unpackPtrLen round-trip', () => {
  const cases: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1024, 32],
    [0xDEADBEEF, 0xCAFEBABE],
    [0xFFFFFFFF, 0xFFFFFFFF],
  ];
  for (const [ptr, len] of cases) {
    const packed = packPtrLen(ptr, len);
    const back = unpackPtrLen(packed);
    assertEquals(back.ptr, ptr);
    assertEquals(back.len, len);
  }
});

Deno.test('packPtrLen rejects out-of-range values', () => {
  assertThrows(() => packPtrLen(-1, 0));
  assertThrows(() => packPtrLen(0x100000000, 0));
  assertThrows(() => packPtrLen(0, -1));
});

// -- i128 round-trips --------------------------------------------

Deno.test('writeI128 / readI128 round-trip non-negative integers', () => {
  const cases = [0, 1, 42, 1000, 0xFFFFFFFF, Number.MAX_SAFE_INTEGER];
  for (const v of cases) {
    const buf = new Uint8Array(16);
    writeI128(new DataView(buf.buffer), 0, v);
    assertEquals(readI128(new DataView(buf.buffer), 0), v);
  }
});

Deno.test("writeI128 / readI128 round-trip negative integers (two's complement)", () => {
  const cases = [-1, -42, -1000, -Number.MAX_SAFE_INTEGER];
  for (const v of cases) {
    const buf = new Uint8Array(16);
    writeI128(new DataView(buf.buffer), 0, v);
    assertEquals(readI128(new DataView(buf.buffer), 0), v);
  }
});

Deno.test('writeI128 rejects unsafe / non-integer / infinite values', () => {
  const buf = new Uint8Array(16);
  const view = new DataView(buf.buffer);
  assertThrows(() => writeI128(view, 0, Number.MAX_SAFE_INTEGER + 1));
  assertThrows(() => writeI128(view, 0, Infinity));
  assertThrows(() => writeI128(view, 0, 1.5));
  assertThrows(() => writeI128(view, 0, NaN));
});

// -- Verifier ----------------------------------------------------

Deno.test('Verifier round-trip', () => {
  const v: Verifier = {
    contract: Hash.digest('test-contract'),
    params: enc('hello'),
  };
  const bytes = encodeVerifier(v);
  // 32-byte hash + 4-byte len + 5-byte params
  assertEquals(bytes.length, 32 + 4 + 5);
  const decoded = decodeVerifier(bytes);
  assertEquals(decoded.length, bytes.length);
  assertEquals(decoded.value.contract.toHex(), v.contract.toHex());
  assertEquals(decoded.value.params, v.params);
});

Deno.test('Verifier with empty params', () => {
  const v: Verifier = { contract: Hash.digest('x'), params: new Uint8Array(0) };
  const bytes = encodeVerifier(v);
  assertEquals(bytes.length, 36);
  const back = decodeVerifier(bytes);
  assertEquals(back.value.params.length, 0);
});

Deno.test('decodeVerifier throws on short input', () => {
  assertThrows(() => decodeVerifier(new Uint8Array(10)));
});

// -- Output ------------------------------------------------------

Deno.test('Output round-trip with body', () => {
  const o: Output = {
    verifier: { contract: Hash.digest('c'), params: enc('p') },
    value: 12345,
    body: enc('hello world'),
  };
  const bytes = encodeOutput(o);
  const back = decodeOutput(bytes);
  assertEquals(back.length, bytes.length);
  assertEquals(back.value.verifier.contract.toHex(), o.verifier.contract.toHex());
  assertEquals(back.value.verifier.params, o.verifier.params);
  assertEquals(back.value.value, o.value);
  assertEquals(back.value.body, o.body);
});

Deno.test('Output round-trip with empty body', () => {
  const o: Output = {
    verifier: { contract: Hash.digest('c'), params: new Uint8Array(0) },
    value: 0,
  };
  const bytes = encodeOutput(o);
  const back = decodeOutput(bytes);
  // Decoded body is an empty Uint8Array (not undefined -- the wire format always
  // carries a length-prefixed body).
  assertEquals(back.value.body?.length ?? -1, 0);
});

// -- Output list (used by fork records) --------------------------

Deno.test('Output list round-trip', () => {
  const outputs: Output[] = [
    { verifier: { contract: Hash.digest('a'), params: enc('one') }, value: 1, body: enc('A') },
    { verifier: { contract: Hash.digest('b'), params: enc('two') }, value: 2, body: enc('BB') },
  ];
  // Encode by hand: u32 count + concatenated outputs.
  const items = outputs.map(encodeOutput);
  const totalLen = 4 + items.reduce((s, b) => s + b.length, 0);
  const buf = new Uint8Array(totalLen);
  new DataView(buf.buffer).setUint32(0, outputs.length, true);
  let offset = 4;
  for (const item of items) {
    buf.set(item, offset);
    offset += item.length;
  }
  const back = decodeOutputList(buf);
  assertEquals(back.length, totalLen);
  assertEquals(back.value.length, 2);
  assertEquals(back.value[1].body, outputs[1].body);
});

// -- Claim -------------------------------------------------------

Deno.test('Claim encoding shape and self-claim byte', () => {
  const c: Claim = {
    verifier: { contract: Hash.digest('c'), params: enc('p') },
    value: 42,
    body: enc('hi'),
    isSelfClaim: true,
  };
  const bytes = encodeClaim(c);
  // verifier(36+1) + value(16) + body header(4) + body(2) + is_self_claim(1)
  assertEquals(bytes.length, 36 + 1 + 16 + 4 + 2 + 1);
  // Last byte is the self-claim flag.
  assertEquals(bytes[bytes.length - 1], 1);
});

Deno.test('Claim list (u32 count + claims) shape', () => {
  const claims: Claim[] = [
    {
      verifier: { contract: Hash.digest('a'), params: enc('1') },
      value: 1,
      body: enc('x'),
      isSelfClaim: false,
    },
    {
      verifier: { contract: Hash.digest('b'), params: enc('22') },
      value: 2,
      body: enc('yy'),
      isSelfClaim: true,
    },
  ];
  const bytes = encodeClaimList(claims);
  assertEquals(new DataView(bytes.buffer).getUint32(0, true), 2);
});

// -- (value, body) reply for request_body / contract_metadata ----

Deno.test('encodeValueAndBody shape', () => {
  const bytes = encodeValueAndBody(7, enc('answer'));
  // 16 bytes i128 + 4 bytes length + 6 bytes body
  assertEquals(bytes.length, 16 + 4 + 6);
  assertEquals(readI128(new DataView(bytes.buffer), 0), 7);
  assertEquals(new DataView(bytes.buffer).getUint32(16, true), 6);
});
