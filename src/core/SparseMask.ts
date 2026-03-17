import { searchSorted } from '../util/sorted.ts';

export interface ChunkBase {
  offset: number;
  size: number;
  population: number;

  /** Sorted absolute positions of set bits within this chunk. */
  oneIndices?: number[];
}

export class SparseMask<ChunkType extends ChunkBase> {
  private chunks: ChunkType[];

  constructor(initialChunk: ChunkType) {
    this.chunks = [initialChunk];
  }

  getChunks(): readonly ChunkType[] {
    return this.chunks;
  }

  /** Total size of the mask (offset + size of last chunk). */
  get totalSize(): number {
    const last = this.chunks[this.chunks.length - 1];
    return last.offset + last.size;
  }

  /**
   * Refine an existing unresolved chunk by providing detailed information
   * for a sub-range aligned with its start or end.
   */
  set(chunk: ChunkType): void {
    const insertAt = this.locateChunk(chunk.offset);
    if (insertAt < 0 || insertAt >= this.chunks.length) {
      throw new Error(`Offset ${chunk.offset} is out of range`);
    }
    const oldChunk = this.chunks[insertAt];
    if (oldChunk.oneIndices !== undefined) {
      throw new Error(`Chunk at offset ${chunk.offset} is already resolved`);
    }
    if (chunk.offset + chunk.size > oldChunk.offset + oldChunk.size) {
      throw new Error(`Chunk extends beyond the target chunk`);
    }
    if (oldChunk.offset === chunk.offset && oldChunk.size === chunk.size) {
      // Exact match -- resolve in place
      if (oldChunk.population !== chunk.population) {
        throw new Error(`Chunk at offset ${chunk.offset} has the wrong population`);
      }
      oldChunk.oneIndices = chunk.oneIndices;
    } else if (oldChunk.offset === chunk.offset) {
      // Split at start: new chunk takes the beginning
      oldChunk.offset += chunk.size;
      oldChunk.size -= chunk.size;
      oldChunk.population -= chunk.population;
      this.chunks.splice(insertAt, 0, chunk);
    } else if (chunk.offset + chunk.size === oldChunk.offset + oldChunk.size) {
      // Split at end: new chunk takes the end
      oldChunk.size -= chunk.size;
      oldChunk.population -= chunk.population;
      this.chunks.splice(insertAt + 1, 0, chunk);
    } else {
      throw new Error(`Chunk must align with start or end of existing chunk`);
    }
    if (oldChunk.population < 0) {
      throw new Error(`Children have higher population than the parent`);
    }
  }

  /**
   * Batch count of zeros below each given index. Indices must be sorted.
   * Returns the count for resolved regions, the unresolved ChunkType
   * for indices falling in unresolved chunks, or undefined if the index
   * is a one-bit (not a valid zero position).
   */
  countZerosLt(indices: number[]): (number | ChunkType | undefined)[] {
    const results: (number | ChunkType | undefined)[] = [];
    let chunkIdx = 0;
    let cumulativeZeros = 0;

    for (const index of indices) {
      // Advance past chunks entirely before this index
      while (
        chunkIdx < this.chunks.length &&
        this.chunks[chunkIdx].offset + this.chunks[chunkIdx].size <= index
      ) {
        const c = this.chunks[chunkIdx];
        cumulativeZeros += c.size - c.population;
        chunkIdx++;
      }

      if (chunkIdx >= this.chunks.length || index < this.chunks[chunkIdx].offset) {
        // Beyond all chunks or before first chunk
        results.push(cumulativeZeros);
        continue;
      }

      const c = this.chunks[chunkIdx];
      if (c.oneIndices === undefined) {
        results.push(c as ChunkType);
      } else {
        const onesBelow = searchSorted(c.oneIndices, (x) => x >= index);
        if (onesBelow < c.oneIndices.length && c.oneIndices[onesBelow] === index) {
          results.push(undefined);
        } else {
          const positionsBelow = index - c.offset;
          results.push(cumulativeZeros + positionsBelow - onesBelow);
        }
      }
    }

    return results;
  }

  /**
   * Batch lookup: find the position of the nth zero for each n. Ns must be sorted.
   * Returns the absolute position for resolved regions, or the unresolved ChunkType
   * for queries falling in unresolved chunks.
   */
  indexNthZero(ns: number[]): (number | ChunkType)[] {
    const results: (number | ChunkType)[] = [];
    let chunkIdx = 0;
    let cumulativeZeros = 0;

    for (const n of ns) {
      // Advance past chunks whose zeros are entirely before the nth zero
      while (chunkIdx < this.chunks.length) {
        const c = this.chunks[chunkIdx];
        const zerosInChunk = c.size - c.population;
        if (cumulativeZeros + zerosInChunk > n) break;
        cumulativeZeros += zerosInChunk;
        chunkIdx++;
      }

      if (chunkIdx >= this.chunks.length) {
        throw new Error(`Zero index ${n} is out of range`);
      }

      const c = this.chunks[chunkIdx];
      if (c.oneIndices === undefined) {
        results.push(c as ChunkType);
      } else {
        const localZeroIdx = n - cumulativeZeros;
        results.push(findNthZero(c.oneIndices, c.offset, localZeroIdx));
      }
    }

    return results;
  }

  /** Find the chunk containing the given offset. */
  private locateChunk(offset: number): number {
    return searchSorted(this.chunks, (c) => c.offset > offset) - 1;
  }
}

/**
 * Given sorted oneIndices (absolute positions), find the absolute position
 * of the nth zero in a chunk starting at `offset`.
 *
 * Uses binary search over oneIndices: for each one at oneIndices[i],
 * there are (oneIndices[i] - offset - i) zeros before it in the chunk.
 */
function findNthZero(oneIndices: number[], offset: number, n: number): number {
  let lo = 0;
  let hi = oneIndices.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (oneIndices[mid] - offset - mid <= n) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  // lo = number of ones at or before the nth zero's position
  return offset + n + lo;
}
