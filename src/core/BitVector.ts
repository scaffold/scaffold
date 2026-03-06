// Protocol spec: docs/protocol/conflict.md (Partial Knowledge and Monotonic Discovery)

/**
 * A chunked bit vector supporting partial knowledge.
 *
 * Bits are grouped into fixed-size chunks. Chunks can be loaded or unknown.
 * Unknown chunks are treated optimistically as all-zeros (no claims),
 * so partial knowledge never produces false conflicts.
 *
 * Designed for encoding block claim masks where the full bit vector may
 * be large and only partially available from the merkle tree.
 */

/** Number of bits per chunk. Must be a multiple of 8. */
export const CHUNK_BITS = 256;
/** Number of bytes per chunk. */
export const CHUNK_BYTES = CHUNK_BITS / 8;

/** Result of rebasing a claim mask through an output transformation. */
export interface RebaseResult {
  /** The rebased bit vector in the target output space. */
  rebased: BitVector;
  /** True if the rebase discovered a conflict with the chain itself. */
  chainConflict: boolean;
}

/** Describes a single block's transformation for rebasing purposes. */
export interface OutputTransformation {
  /** Bit vector of outputs claimed (removed) by this block, length = input size. */
  claimMask: BitVector;
  /** Number of new outputs prepended by this block. */
  newOutputCount: number;
}

export class BitVector {
  /** Total number of bits in the vector. */
  private readonly _length: number;

  /** Chunk data. Null means the chunk is unknown (treated as zeros). */
  private readonly chunks: (Uint8Array | null)[];

  private constructor(length: number, chunks: (Uint8Array | null)[]) {
    this._length = length;
    this.chunks = chunks;
  }

  /** Create a BitVector with all bits set to false. */
  static empty(length: number): BitVector {
    const numChunks = Math.ceil(length / CHUNK_BITS);
    const chunks: (Uint8Array | null)[] = [];
    for (let i = 0; i < numChunks; i++) {
      chunks.push(new Uint8Array(CHUNK_BYTES));
    }
    return new BitVector(length, chunks);
  }

  /** Create a BitVector with all chunks unknown (partial knowledge). */
  static unknown(length: number): BitVector {
    const numChunks = Math.ceil(length / CHUNK_BITS);
    const chunks: (Uint8Array | null)[] = new Array(numChunks).fill(null);
    return new BitVector(length, chunks);
  }

  /** Create a BitVector from an array of booleans. */
  static fromBits(bits: boolean[]): BitVector {
    const bv = BitVector.empty(bits.length);
    for (let i = 0; i < bits.length; i++) {
      if (bits[i]) bv.set(i, true);
    }
    return bv;
  }

  /** Create a BitVector from an array of set bit indices. */
  static fromIndices(length: number, indices: number[]): BitVector {
    const bv = BitVector.empty(length);
    for (const i of indices) {
      bv.set(i, true);
    }
    return bv;
  }

  get length(): number {
    return this._length;
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  /** Get the value of a bit. Returns false if the chunk is unknown. */
  get(index: number): boolean {
    if (index < 0 || index >= this._length) return false;
    const chunkIdx = Math.floor(index / CHUNK_BITS);
    const chunk = this.chunks[chunkIdx];
    if (!chunk) return false;
    const bitIdx = index % CHUNK_BITS;
    const byteIdx = Math.floor(bitIdx / 8);
    const bitOffset = bitIdx % 8;
    return (chunk[byteIdx] & (1 << bitOffset)) !== 0;
  }

  /** Set the value of a bit. Creates the chunk if it was unknown. */
  set(index: number, value: boolean): void {
    if (index < 0 || index >= this._length) return;
    const chunkIdx = Math.floor(index / CHUNK_BITS);
    let chunk = this.chunks[chunkIdx];
    if (!chunk) {
      chunk = new Uint8Array(CHUNK_BYTES);
      this.chunks[chunkIdx] = chunk;
    }
    const bitIdx = index % CHUNK_BITS;
    const byteIdx = Math.floor(bitIdx / 8);
    const bitOffset = bitIdx % 8;
    if (value) {
      chunk[byteIdx] |= 1 << bitOffset;
    } else {
      chunk[byteIdx] &= ~(1 << bitOffset);
    }
  }

  /** Whether a chunk is loaded (not unknown). */
  isChunkLoaded(chunkIndex: number): boolean {
    return chunkIndex >= 0 && chunkIndex < this.chunks.length &&
      this.chunks[chunkIndex] !== null;
  }

  /** Load a chunk's data. */
  loadChunk(chunkIndex: number, data: Uint8Array): void {
    if (chunkIndex < 0 || chunkIndex >= this.chunks.length) return;
    const chunk = new Uint8Array(CHUNK_BYTES);
    chunk.set(data.subarray(0, CHUNK_BYTES));
    this.chunks[chunkIndex] = chunk;
  }

  /**
   * Check if this bit vector intersects with another (bitwise AND != 0).
   * Only checks loaded chunks on both sides. Unknown chunks are treated
   * as zeros (optimistic: no conflict from missing data).
   */
  intersects(other: BitVector): boolean {
    const minChunks = Math.min(this.chunks.length, other.chunks.length);
    for (let c = 0; c < minChunks; c++) {
      const a = this.chunks[c];
      const b = other.chunks[c];
      if (!a || !b) continue;
      for (let i = 0; i < CHUNK_BYTES; i++) {
        if ((a[i] & b[i]) !== 0) return true;
      }
    }
    return false;
  }

  /** Count the number of set bits (in loaded chunks only). */
  popcount(): number {
    let count = 0;
    for (const chunk of this.chunks) {
      if (!chunk) continue;
      for (let i = 0; i < CHUNK_BYTES; i++) {
        let byte = chunk[i];
        // Brian Kernighan's algorithm
        while (byte) {
          byte &= byte - 1;
          count++;
        }
      }
    }
    return count;
  }

  /** Create a copy of this bit vector. */
  clone(): BitVector {
    const newChunks = this.chunks.map(
      (c) => c ? new Uint8Array(c) : null,
    );
    return new BitVector(this._length, newChunks);
  }

  /** Serialize to a JSON-safe representation. */
  toJSON(): { length: number; chunks: (number[] | null)[] } {
    return {
      length: this._length,
      chunks: this.chunks.map((c) => c ? Array.from(c) : null),
    };
  }

  /** Deserialize from a JSON representation. */
  static fromJSON(json: { length: number; chunks: (number[] | null)[] }): BitVector {
    const chunks = json.chunks.map(
      (c) => c ? new Uint8Array(c) : null,
    );
    return new BitVector(json.length, chunks);
  }

  /** Bitwise OR: merge another bit vector's set bits into this one. */
  or(other: BitVector): void {
    const minChunks = Math.min(this.chunks.length, other.chunks.length);
    for (let c = 0; c < minChunks; c++) {
      const b = other.chunks[c];
      if (!b) continue;
      let a = this.chunks[c];
      if (!a) {
        a = new Uint8Array(CHUNK_BYTES);
        this.chunks[c] = a;
      }
      for (let i = 0; i < CHUNK_BYTES; i++) {
        a[i] |= b[i];
      }
    }
  }

  /**
   * Rebase this claim mask through a single output transformation.
   *
   * The transformation removes claimed outputs and prepends new ones.
   * This maps our claim indices from the input space to the output space.
   *
   * Returns a RebaseResult with the rebased vector and whether a chain
   * conflict was detected (we claim an output the transformation also claims).
   */
  rebase(transformation: OutputTransformation): RebaseResult {
    const { claimMask, newOutputCount } = transformation;
    let chainConflict = false;

    // Collect our set bit positions
    const setBits: number[] = [];
    for (let i = 0; i < this._length; i++) {
      if (this.get(i)) setBits.push(i);
    }

    // Map each claimed index through the transformation
    const newLength = claimMask.length - claimMask.popcount() + newOutputCount;
    const result = BitVector.empty(newLength);

    for (const idx of setBits) {
      if (idx >= claimMask.length) {
        // Index beyond the transformation's scope — shouldn't happen
        continue;
      }

      if (claimMask.get(idx)) {
        // Both we and the chain claim this output — conflict!
        chainConflict = true;
        continue;
      }

      // Count how many outputs before idx were removed by the transformation
      let removed = 0;
      for (let j = 0; j < idx; j++) {
        if (claimMask.get(j)) removed++;
      }

      // New index: shift by prepended outputs, offset by removals
      const newIdx = newOutputCount + (idx - removed);
      if (newIdx < newLength) {
        result.set(newIdx, true);
      }
    }

    return { rebased: result, chainConflict };
  }
}
