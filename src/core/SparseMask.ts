import { searchSorted } from '../util/sorted.ts';

interface Chunk {
  offset: number;
  size: number;
  population: number;

  indexDeltas?: number[];
}

export class SparseMask {
  private chunks: Chunk[];

  constructor(size: number, population: number) {
    this.chunks = [{ offset: 0, size, population }];
  }

  set(offset: number, size: number, indexDeltas: number[]): void {
    const insertAt = this.locateChunk(offset);
    if (insertAt >= this.chunks.length) {
      throw new Error(`Offset ${offset} is out of range`);
    }
    const chunk = this.chunks[insertAt];
    if (chunk.indexDeltas !== undefined || size > chunk.size) {
      throw new Error(`Chunk at offset ${offset} is already set`);
    }
    if (chunk.offset === offset && chunk.size === size) {
      if (chunk.population !== indexDeltas.length) {
        throw new Error(`Chunk at offset ${offset} has the wrong population`);
      }
      chunk.indexDeltas = indexDeltas;
    } else if (chunk.offset === offset) {
      chunk.offset += size;
      chunk.size -= size;
      chunk.population -= indexDeltas.length;
      this.chunks.splice(insertAt, 0, {
        offset,
        size,
        population: indexDeltas.length,
        indexDeltas,
      });
    } else if (offset + size === chunk.offset + chunk.size) {
      chunk.size -= size;
      chunk.population -= indexDeltas.length;
      this.chunks.splice(insertAt + 1, 0, {
        offset,
        size,
        population: indexDeltas.length,
        indexDeltas,
      });
    }else{
      throw new Error(`Internal error`); // Should never happen
    }
    if (chunk.population < 0) {
      throw new Error(`Children have higher population than the parent`);
    }
  }

  countZerosLt(indices: number[]){}

  indexNthZero(n: number[]){}

  private locateChunk(offset: number): number {
    return searchSorted(this.chunks, (c) => c.offset >= offset);
  }
}
