import { assertEquals, assertThrows } from '@std/assert';
import { ChunkBase, SparseMask } from '../src/core/SparseMask.ts';

interface TestChunk extends ChunkBase {
  label?: string;
}

function chunk(
  offset: number,
  size: number,
  population: number,
  oneIndices?: number[],
  label?: string,
): TestChunk {
  return { offset, size, population, oneIndices, label };
}

// -- Constructor and basic structure --

Deno.test('SparseMask: single resolved chunk', () => {
  const mask = new SparseMask(chunk(0, 10, 3, [2, 5, 8]));
  assertEquals(mask.totalSize, 10);
  assertEquals(mask.getChunks().length, 1);
});

Deno.test('SparseMask: single unresolved chunk', () => {
  const mask = new SparseMask(chunk(0, 100, 20));
  assertEquals(mask.totalSize, 100);
  assertEquals(mask.getChunks()[0].oneIndices, undefined);
});

// -- set() --

Deno.test('SparseMask: set exact match resolves chunk', () => {
  const mask = new SparseMask(chunk(0, 10, 3));
  mask.set(chunk(0, 10, 3, [1, 4, 7]));
  assertEquals(mask.getChunks().length, 1);
  assertEquals(mask.getChunks()[0].oneIndices, [1, 4, 7]);
});

Deno.test('SparseMask: set splits at start', () => {
  const mask = new SparseMask(chunk(0, 15, 5));
  mask.set(chunk(0, 5, 1, [3]));
  const chunks = mask.getChunks();
  assertEquals(chunks.length, 2);
  assertEquals(chunks[0].offset, 0);
  assertEquals(chunks[0].size, 5);
  assertEquals(chunks[0].population, 1);
  assertEquals(chunks[0].oneIndices, [3]);
  assertEquals(chunks[1].offset, 5);
  assertEquals(chunks[1].size, 10);
  assertEquals(chunks[1].population, 4);
  assertEquals(chunks[1].oneIndices, undefined);
});

Deno.test('SparseMask: set splits at end', () => {
  const mask = new SparseMask(chunk(0, 15, 5));
  mask.set(chunk(10, 5, 2, [11, 13]));
  const chunks = mask.getChunks();
  assertEquals(chunks.length, 2);
  assertEquals(chunks[0].offset, 0);
  assertEquals(chunks[0].size, 10);
  assertEquals(chunks[0].population, 3);
  assertEquals(chunks[1].offset, 10);
  assertEquals(chunks[1].size, 5);
  assertEquals(chunks[1].population, 2);
  assertEquals(chunks[1].oneIndices, [11, 13]);
});

Deno.test('SparseMask: progressive splitting', () => {
  const mask = new SparseMask(chunk(0, 20, 8));
  // Split start
  mask.set(chunk(0, 5, 2, [1, 3]));
  // Split end of remaining [5, 20)
  mask.set(chunk(15, 5, 1, [17]));
  // Resolve the middle [5, 15)
  mask.set(chunk(5, 10, 5, [6, 8, 10, 12, 14]));

  const chunks = mask.getChunks();
  assertEquals(chunks.length, 3);
  assertEquals(chunks[0].oneIndices, [1, 3]);
  assertEquals(chunks[1].oneIndices, [6, 8, 10, 12, 14]);
  assertEquals(chunks[2].oneIndices, [17]);
});

Deno.test('SparseMask: set rejects wrong population', () => {
  const mask = new SparseMask(chunk(0, 10, 3));
  assertThrows(
    () => mask.set(chunk(0, 10, 5, [1, 2, 3, 4, 5])),
    Error,
    'wrong population',
  );
});

Deno.test('SparseMask: set rejects already resolved chunk', () => {
  const mask = new SparseMask(chunk(0, 10, 3, [1, 4, 7]));
  assertThrows(
    () => mask.set(chunk(0, 10, 3, [1, 4, 7])),
    Error,
    'already resolved',
  );
});

Deno.test('SparseMask: set rejects chunk exceeding parent population', () => {
  const mask = new SparseMask(chunk(0, 10, 2));
  assertThrows(
    () => mask.set(chunk(0, 5, 3, [0, 1, 2])),
    Error,
    'higher population',
  );
});

Deno.test('SparseMask: set rejects misaligned chunk', () => {
  const mask = new SparseMask(chunk(0, 20, 5));
  assertThrows(
    () => mask.set(chunk(5, 5, 2, [6, 8])),
    Error,
    'must align',
  );
});

Deno.test('SparseMask: set rejects out-of-range offset', () => {
  const mask = new SparseMask(chunk(0, 10, 3));
  assertThrows(
    () => mask.set(chunk(20, 5, 1, [21])),
    Error,
    'extends beyond',
  );
});

// -- countZerosLt --
// Bit vector from the spec: "0001011001" at offset 5
// Ones at absolute positions: 8, 10, 11, 14
// Chunk 0: [0, 5), population 1, unresolved
// Chunk 1: [5, 15), population 4, oneIndices [8, 10, 11, 14]

function makeSpecMask(): SparseMask<TestChunk> {
  const mask = new SparseMask(chunk(0, 15, 5, undefined, 'root'));
  mask.set(chunk(0, 5, 1, undefined, 'unresolved'));
  mask.set(chunk(5, 10, 4, [8, 10, 11, 14]));
  return mask;
}

Deno.test('SparseMask: countZerosLt with unresolved and resolved chunks', () => {
  const mask = makeSpecMask();
  const results = mask.countZerosLt([2, 5, 9, 11, 12]);

  // Index 2 falls in unresolved chunk 0
  assertEquals(typeof results[0], 'object');
  assertEquals((results[0] as TestChunk).label, 'unresolved');

  // Index 5: all 4 zeros from chunk 0 (size 5, pop 1)
  assertEquals(results[1], 4);

  // Index 9: 4 zeros from chunk 0 + positions 5,6,7 are zeros, 8 is a one = 3 zeros
  assertEquals(results[2], 7);

  // Index 11 is a one-bit -> undefined
  assertEquals(results[3], undefined);

  // Index 12: 4 zeros from chunk 0 + zeros at 5,6,7,9,12 but 12 is not < 12 = 4 zeros
  assertEquals(results[4], 8);
});

Deno.test('SparseMask: countZerosLt on fully resolved mask', () => {
  // "10010110" at offset 0 -- ones at 0, 3, 5, 6
  const mask = new SparseMask(chunk(0, 8, 4, [0, 3, 5, 6]));
  // Only query zero positions and boundaries
  const results = mask.countZerosLt([1, 2, 4, 7, 8]);
  assertEquals(results, [0, 1, 2, 3, 4]);
});

Deno.test('SparseMask: countZerosLt returns undefined for one-bit indices', () => {
  // ones at 0, 3, 5, 6
  const mask = new SparseMask(chunk(0, 8, 4, [0, 3, 5, 6]));
  const results = mask.countZerosLt([0, 3, 5, 6]);
  assertEquals(results, [undefined, undefined, undefined, undefined]);
});

Deno.test('SparseMask: countZerosLt mixed zeros and ones', () => {
  // ones at 0, 3, 5, 6 -- zeros at 1, 2, 4, 7
  const mask = new SparseMask(chunk(0, 8, 4, [0, 3, 5, 6]));
  const results = mask.countZerosLt([0, 1, 2, 3, 4, 5, 6, 7]);
  // 0=one, 1=zero(0), 2=zero(1), 3=one, 4=zero(2), 5=one, 6=one, 7=zero(3)
  assertEquals(results, [undefined, 0, 1, undefined, 2, undefined, undefined, 3]);
});

Deno.test('SparseMask: countZerosLt at chunk boundaries', () => {
  const mask = new SparseMask(chunk(0, 20, 4));
  mask.set(chunk(0, 10, 2, [3, 7]));
  mask.set(chunk(10, 10, 2, [12, 18]));

  // At boundary index 10: chunk 0 has 8 zeros
  const results = mask.countZerosLt([0, 10, 20]);
  assertEquals(results[0], 0);
  assertEquals(results[1], 8);
  assertEquals(results[2], 16); // 8 + 8
});

Deno.test('SparseMask: countZerosLt empty ones', () => {
  const mask = new SparseMask(chunk(0, 10, 0, []));
  assertEquals(mask.countZerosLt([5]), [5]);
  assertEquals(mask.countZerosLt([10]), [10]);
});

Deno.test('SparseMask: countZerosLt all ones', () => {
  const mask = new SparseMask(chunk(0, 4, 4, [0, 1, 2, 3]));
  assertEquals(
    mask.countZerosLt([0, 1, 2, 3, 4]),
    [undefined, undefined, undefined, undefined, 0],
  );
});

// -- indexNthZero --

Deno.test('SparseMask: indexNthZero with unresolved and resolved chunks', () => {
  const mask = makeSpecMask();
  const results = mask.indexNthZero([2, 4, 7, 8]);

  // n=2: falls in unresolved chunk 0 (which has 4 zeros, 2 < 4)
  assertEquals(typeof results[0], 'object');
  assertEquals((results[0] as TestChunk).label, 'unresolved');

  // n=4: chunk 0 has exactly 4 zeros, so this is the 0th zero of chunk 1 = position 5
  assertEquals(results[1], 5);

  // n=7: 3rd zero of chunk 1 = position 9 (zeros at 5, 6, 7, 9)
  assertEquals(results[2], 9);

  // n=8: 4th zero of chunk 1 = position 12 (zeros at 5, 6, 7, 9, 12)
  assertEquals(results[3], 12);
});

Deno.test('SparseMask: indexNthZero on fully resolved mask', () => {
  // "10010110" -- ones at 0, 3, 5, 6 -- zeros at 1, 2, 4, 7
  const mask = new SparseMask(chunk(0, 8, 4, [0, 3, 5, 6]));
  assertEquals(mask.indexNthZero([0, 1, 2, 3]), [1, 2, 4, 7]);
});

Deno.test('SparseMask: indexNthZero with no ones', () => {
  const mask = new SparseMask(chunk(0, 10, 0, []));
  assertEquals(mask.indexNthZero([0, 5, 9]), [0, 5, 9]);
});

Deno.test('SparseMask: indexNthZero out of range throws', () => {
  const mask = new SparseMask(chunk(0, 5, 2, [1, 3]));
  // 3 zeros total, requesting the 3rd (0-based) is valid, 4th is not
  assertThrows(
    () => mask.indexNthZero([4]),
    Error,
    'out of range',
  );
});

Deno.test('SparseMask: indexNthZero with offset', () => {
  // Chunk at offset 10, size 6, ones at 11, 14 -- zeros at 10, 12, 13, 15
  const mask = new SparseMask(chunk(10, 6, 2, [11, 14]));
  assertEquals(mask.indexNthZero([0, 1, 2, 3]), [10, 12, 13, 15]);
});

// -- countZerosLt and indexNthZero are inverses --

Deno.test('SparseMask: countZerosLt and indexNthZero are inverses', () => {
  const mask = new SparseMask(chunk(0, 8, 4, [0, 3, 5, 6]));

  // Get all zero positions
  const zeroPositions = mask.indexNthZero([0, 1, 2, 3]) as number[];
  assertEquals(zeroPositions, [1, 2, 4, 7]);

  // countZerosLt at each zero position should give back the index
  const counts = mask.countZerosLt(zeroPositions) as number[];
  assertEquals(counts, [0, 1, 2, 3]);

  // countZerosLt at position+1: may be undefined if position+1 is a one-bit
  // zeros at 1, 2, 4, 7 -> +1 = 2, 3, 5, 8
  // 2 is a zero -> 1; 3 is a one -> undefined; 5 is a one -> undefined; 8 is past end -> 4
  const countsAfter = mask.countZerosLt(zeroPositions.map((p) => p + 1));
  assertEquals(countsAfter, [1, undefined, undefined, 4]);
});

Deno.test('SparseMask: inverse property across multiple resolved chunks', () => {
  const mask = new SparseMask(chunk(0, 20, 6));
  mask.set(chunk(0, 10, 3, [1, 5, 9]));
  mask.set(chunk(10, 10, 3, [10, 14, 18]));

  // 14 total zeros
  const ns = Array.from({ length: 14 }, (_, i) => i);
  const positions = mask.indexNthZero(ns) as number[];

  // Verify inverse
  const backToNs = mask.countZerosLt(positions) as number[];
  assertEquals(backToNs, ns);
});

// -- Edge cases --

Deno.test('SparseMask: single element chunk, zero', () => {
  const mask = new SparseMask(chunk(0, 1, 0, []));
  assertEquals(mask.countZerosLt([0, 1]), [0, 1]);
  assertEquals(mask.indexNthZero([0]), [0]);
});

Deno.test('SparseMask: single element chunk, one', () => {
  const mask = new SparseMask(chunk(0, 1, 1, [0]));
  assertEquals(mask.countZerosLt([0, 1]), [undefined, 0]);
  assertThrows(() => mask.indexNthZero([0]), Error, 'out of range');
});

Deno.test('SparseMask: multiple unresolved chunks in sequence', () => {
  const mask = new SparseMask(chunk(0, 30, 10));
  mask.set(chunk(0, 10, 3, undefined, 'a'));
  mask.set(chunk(20, 10, 4, undefined, 'c'));
  // Middle chunk [10, 20) has pop 3, still unresolved

  const results = mask.countZerosLt([5, 15, 25]);
  // Index 5 in unresolved chunk 'a'
  assertEquals((results[0] as TestChunk).label, 'a');
  // Index 15 in unresolved middle chunk
  assertEquals(typeof results[1], 'object');
  assertEquals((results[1] as TestChunk).offset, 10);
  // Index 25 in unresolved chunk 'c'
  assertEquals((results[2] as TestChunk).label, 'c');
});
