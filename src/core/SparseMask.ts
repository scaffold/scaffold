import { searchSorted } from '../util/sorted.ts';

interface ChunkBase {
  offset: number;
  size: number;
  population: number;

  indexDeltas?: number[];
}

export class SparseMask<ChunkType extends ChunkBase> {
  private chunks: ChunkType[];

  constructor(initialChunk: ChunkType) {
    this.chunks = [initialChunk];
  }

  set(chunk: ChunkType): void {
    const insertAt = this.locateChunk(chunk.offset);
    if (insertAt >= this.chunks.length) {
      throw new Error(`Offset ${chunk.offset} is out of range`);
    }
    const oldChunk = this.chunks[insertAt];
    if (oldChunk.indexDeltas !== undefined || chunk.size > oldChunk.size) {
      throw new Error(`Chunk at offset ${chunk.offset} is already set`);
    }
    if (oldChunk.offset === chunk.offset && oldChunk.size === chunk.size) {
      if (oldChunk.population !== chunk.population) {
        throw new Error(`Chunk at offset ${chunk.offset} has the wrong population`);
      }
      oldChunk.indexDeltas = chunk.indexDeltas;
    } else if (oldChunk.offset === chunk.offset) {
      oldChunk.offset += chunk.size;
      oldChunk.size -= chunk.size;
      oldChunk.population -= chunk.population;
      this.chunks.splice(insertAt, 0, chunk);
    } else if (chunk.offset + chunk.size === oldChunk.offset + oldChunk.size) {
      oldChunk.size -= chunk.size;
      oldChunk.population -= chunk.population;
      this.chunks.splice(insertAt + 1, 0, chunk);
    } else {
      throw new Error(`Internal error`); // Should never happen
    }
    if (oldChunk.population < 0) {
      throw new Error(`Children have higher population than the parent`);
    }
  }

  countZerosLt(indices: number[]): (number | ChunkType)[] {
    return [];
  }

  indexNthZero(n: number[]): (number | ChunkType)[] {
    return [];
  }

  private locateChunk(offset: number): number {
    return searchSorted(this.chunks, (c) => c.offset >= offset);
  }
}
