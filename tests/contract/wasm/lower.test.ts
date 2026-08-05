import { assertEquals, assertThrows } from '@std/assert';
import {
  GuestView,
  packPtrLen,
  readBytes,
  unpackPtrLen,
  writeBytes,
} from '../../../src/contract/wasm/lower.ts';

const makeGuest = (): GuestView => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let next = 16;
  return {
    memory,
    alloc: (len) => {
      const ptr = next;
      next += len;
      return ptr;
    },
  };
};

Deno.test('packPtrLen and unpackPtrLen round-trip', () => {
  const packed = packPtrLen(0x12345678, 0x9abcdef0);
  assertEquals(unpackPtrLen(packed), { ptr: 0x12345678, len: 0x9abcdef0 });
});

Deno.test('packPtrLen rejects the reserved pointer zero', () => {
  assertThrows(() => packPtrLen(0, 4), Error);
});

Deno.test('unpackPtrLen rejects the absent sentinel', () => {
  assertThrows(() => unpackPtrLen(0n), Error);
});

Deno.test('writeBytes and readBytes round-trip through guest memory', () => {
  const guest = makeGuest();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const { ptr, len } = writeBytes(guest, bytes);
  assertEquals(len, 4);
  assertEquals(readBytes(guest, ptr, len), bytes);
});

Deno.test('empty bytes are present-but-empty, never the absent sentinel', () => {
  const guest = makeGuest();
  const { ptr, len } = writeBytes(guest, new Uint8Array());
  assertEquals(len, 0);
  assertEquals(packPtrLen(ptr, len) === 0n, false);
});

Deno.test('writeBytes rejects a guest alloc that returns zero', () => {
  const guest = makeGuest();
  guest.alloc = () => 0;
  assertThrows(() => writeBytes(guest, new Uint8Array([1])), Error);
});

Deno.test('readBytes copies rather than views', () => {
  const guest = makeGuest();
  const { ptr, len } = writeBytes(guest, new Uint8Array([7]));
  const read = readBytes(guest, ptr, len);
  new Uint8Array(guest.memory.buffer)[ptr] = 9;
  assertEquals(read[0], 7);
});
