import { assert, assertEquals, assertStrictEquals, assertThrows } from '@std/assert';
import {
  MessageJoiner,
  MessageJoinerOptions,
  MessageSplitter,
} from '../../../src/peer/network/MessageSplitter.ts';

const MAGIC_HEADER_SIZE = 16;

// A message whose first four bytes are the magic word (57 little-endian), which is
// what forces the chunked path even when the message would fit.
const magicPrefixed = (size: number): Uint8Array => {
  const data = new Uint8Array(size);
  new DataView(data.buffer).setUint32(0, 57, true);
  for (let i = 4; i < size; i++) data[i] = i & 0xff;
  return data;
};

const payload = (size: number, seed = 1): Uint8Array =>
  new Uint8Array(size).map((_, i) => (i * 7 + seed) & 0xff);

function makeJoiner(options: Partial<MessageJoinerOptions> = {}): MessageJoiner {
  return new MessageJoiner({ nowMs: () => 0, ...options });
}

Deno.test('a message that fits is passed through without copying it', () => {
  const message = payload(64);
  const chunks = [...new MessageSplitter(1024).send(message)];

  assertEquals(chunks.length, 1);
  assertStrictEquals(chunks[0], message);
});

Deno.test('a passed-through message is yielded unchanged by the joiner', () => {
  const message = payload(64);
  assertEquals([...makeJoiner().recv(message)], [message]);
});

Deno.test('a message beginning with the magic word is chunked even though it fits', () => {
  const message = magicPrefixed(64);
  const chunks = [...new MessageSplitter(1024).send(message)];

  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].byteLength, MAGIC_HEADER_SIZE + 64);
  assertEquals([...makeJoiner().recv(chunks[0])], [message]);
});

Deno.test('a message beginning with the magic word round-trips with no size limit', () => {
  // Regression: splitSize was Infinity, so Math.ceil(len / Infinity) yielded zero
  // chunks and the message vanished.
  const message = magicPrefixed(1000);
  const chunks = [...new MessageSplitter(Infinity).send(message)];

  assertEquals(chunks.length, 1);
  assertEquals([...makeJoiner().recv(chunks[0])], [message]);
});

Deno.test('a message larger than the chunk size round-trips through the joiner', () => {
  const message = payload(5000);
  const chunks = [...new MessageSplitter(1024).send(message)];
  const joiner = makeJoiner();

  assertEquals(chunks.length, Math.ceil(5000 / (1024 - MAGIC_HEADER_SIZE)));
  for (const chunk of chunks) assert(chunk.byteLength <= 1024);

  const joined = chunks.flatMap((chunk) => [...joiner.recv(chunk)]);
  assertEquals(joined, [message]);
});

Deno.test('a message exactly the chunk size is passed through', () => {
  const message = payload(1024);
  const chunks = [...new MessageSplitter(1024).send(message)];

  assertEquals(chunks.length, 1);
  assertStrictEquals(chunks[0], message);
});

Deno.test('a message one byte over the chunk size is split in two', () => {
  const chunks = [...new MessageSplitter(1024).send(payload(1025))];
  assertEquals(chunks.length, 2);
});

Deno.test('chunks arriving out of order still reassemble', () => {
  const message = payload(5000);
  const chunks = [...new MessageSplitter(1024).send(message)];
  const joiner = makeJoiner();

  const joined = chunks.toReversed().flatMap((chunk) => [...joiner.recv(chunk)]);
  assertEquals(joined, [message]);
});

Deno.test('a duplicated chunk does not complete a message early', () => {
  const message = payload(5000);
  const chunks = [...new MessageSplitter(1024).send(message)];
  const joiner = makeJoiner();

  assertEquals([...joiner.recv(chunks[0])], []);
  assertEquals([...joiner.recv(chunks[0])], []);

  const joined = chunks.slice(1).flatMap((chunk) => [...joiner.recv(chunk)]);
  assertEquals(joined, [message]);
});

Deno.test('two interleaved messages reassemble independently', () => {
  const splitter = new MessageSplitter(1024);
  const first = payload(3000, 1);
  const second = payload(3000, 2);
  const firstChunks = [...splitter.send(first)];
  const secondChunks = [...splitter.send(second)];
  const joiner = makeJoiner();

  const joined: Uint8Array[] = [];
  for (let i = 0; i < firstChunks.length; i++) {
    joined.push(...joiner.recv(firstChunks[i]), ...joiner.recv(secondChunks[i]));
  }
  assertEquals(joined, [first, second]);
});

Deno.test('a frame shorter than a chunk header is passed through rather than throwing', () => {
  // Regression: `new Uint32Array(buf, offset, 4)` threw RangeError on short frames.
  const message = payload(4);
  assertEquals([...makeJoiner().recv(message)], [message]);
});

Deno.test('a chunk backed by an unaligned view is read correctly', () => {
  // Regression: Uint32Array requires a 4-byte-aligned byteOffset, so any odd-offset
  // subarray from a transport threw.
  const message = magicPrefixed(64);
  const chunk = [...new MessageSplitter(1024).send(message)][0];

  const backing = new Uint8Array(chunk.byteLength + 3);
  backing.set(chunk, 3);
  const unaligned = backing.subarray(3);

  assertEquals([...makeJoiner().recv(unaligned)], [message]);
});

Deno.test('a chunk header declaring an out-of-range index is rejected', () => {
  const chunk = [...new MessageSplitter(1024).send(magicPrefixed(64))][0];
  new DataView(chunk.buffer).setUint32(12, 9, true);

  assertThrows(() => [...makeJoiner().recv(chunk)], Error, 'out of bounds');
});

Deno.test('a chunk header declaring zero chunks is rejected', () => {
  const chunk = [...new MessageSplitter(1024).send(magicPrefixed(64))][0];
  new DataView(chunk.buffer).setUint32(8, 0, true);

  assertThrows(() => [...makeJoiner().recv(chunk)], Error, 'declares 0 chunks');
});

Deno.test('a chunk header declaring more chunks than the cap is rejected', () => {
  const chunk = [...new MessageSplitter(1024).send(magicPrefixed(64))][0];
  new DataView(chunk.buffer).setUint32(8, 100_000, true);

  assertThrows(
    () => [...makeJoiner({ maxChunkCount: 16 }).recv(chunk)],
    Error,
    'over the 16 cap',
  );
});

Deno.test('a partial message is dropped once it passes its ttl', () => {
  const chunks = [...new MessageSplitter(1024).send(payload(5000))];
  let now = 0;
  const joiner = makeJoiner({ nowMs: () => now, partialTtlMs: 100 });

  assertEquals([...joiner.recv(chunks[0])], []);
  now = 1000;

  // The surviving chunks can no longer complete the dropped partial.
  const joined = chunks.slice(1).flatMap((chunk) => [...joiner.recv(chunk)]);
  assertEquals(joined, []);
});

Deno.test('partials past the cap are evicted oldest first', () => {
  const splitter = new MessageSplitter(1024);
  const messages = [payload(3000, 1), payload(3000, 2), payload(3000, 3)];
  const chunked = messages.map((message) => [...splitter.send(message)]);
  const joiner = makeJoiner({ maxPartials: 2 });

  // Open three partials; the first is evicted when the third arrives.
  for (const chunks of chunked) {
    assertEquals([...joiner.recv(chunks[0])], []);
  }

  const first = chunked[0].slice(1).flatMap((chunk) => [...joiner.recv(chunk)]);
  assertEquals(first, []);

  const third = chunked[2].slice(1).flatMap((chunk) => [...joiner.recv(chunk)]);
  assertEquals(third, [messages[2]]);
});

Deno.test('an empty message round-trips through the chunked path', () => {
  const chunks = [...new MessageSplitter(Infinity).send(magicPrefixed(4))];
  assertEquals(chunks.length, 1);
  assertEquals([...makeJoiner().recv(chunks[0])], [magicPrefixed(4)]);
});
