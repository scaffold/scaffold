import { ScopedLogger } from '../../logic/Logger.ts';
import { arrConcat } from '../../util/buffer.ts';
import { assert, range } from '../../util/functional.ts';
import { mapPut } from '../../util/map.ts';

// Wire format, unchanged from src/util/MessageSplitter.ts:
//   a message that fits the chunk size and does not begin with the magic word is
//   sent verbatim, with no header and no copy. Anything else is split into chunks
//   carrying [magic u32][msgId u32][chunkCount u32][chunkIdx u32], little-endian.
// The escape is exact rather than heuristic: send() chunks any message beginning
// with the magic word even when it would fit, so a headerless frame provably never
// starts with it.
const MAGIC_WORD = 57;
const HEADER_SIZE = 16;

const DEFAULT_PARTIAL_TTL_MS = 30_000;
const DEFAULT_MAX_PARTIALS = 64;
const DEFAULT_MAX_CHUNK_COUNT = 65_536;

function startsWithMagic(data: Uint8Array): boolean {
  return data.byteLength >= 4 &&
    new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true) === MAGIC_WORD;
}

export class MessageSplitter {
  private nextMsgId = 0;

  constructor(private chunkSize: number) {}

  *send(message: Uint8Array): Generator<Uint8Array> {
    if (message.byteLength <= this.chunkSize && !startsWithMagic(message)) {
      yield message;
      return;
    }

    // Clamped so an unbounded chunkSize yields one chunk rather than
    // Math.ceil(len / Infinity) === 0 chunks, which dropped the message silently.
    const splitSize = Math.min(this.chunkSize - HEADER_SIZE, Math.max(1, message.byteLength));
    assert(splitSize > 0, `Chunk size ${this.chunkSize} is too small to carry a header!`);

    const chunkCount = Math.max(1, Math.ceil(message.byteLength / splitSize));
    const msgId = this.nextMsgId;
    this.nextMsgId = (this.nextMsgId + 1) >>> 0;

    for (let i = 0; i < chunkCount; i++) {
      const payload = message.subarray(i * splitSize, (i + 1) * splitSize);
      const chunk = new Uint8Array(HEADER_SIZE + payload.byteLength);
      const view = new DataView(chunk.buffer);
      view.setUint32(0, MAGIC_WORD, true);
      view.setUint32(4, msgId, true);
      view.setUint32(8, chunkCount, true);
      view.setUint32(12, i, true);
      chunk.set(payload, HEADER_SIZE);
      yield chunk;
    }
  }
}

interface Partial {
  chunkCount: number;
  lastUpdateMs: number;
  chunks: Map<number, Uint8Array>;
}

export interface MessageJoinerOptions {
  nowMs: () => number;
  log?: ScopedLogger;
  partialTtlMs?: number;
  maxPartials?: number;
  maxChunkCount?: number;
}

export class MessageJoiner {
  private partials = new Map<string, Partial>();

  private nowMs: () => number;
  private log?: ScopedLogger;
  private partialTtlMs: number;
  private maxPartials: number;
  private maxChunkCount: number;

  constructor(options: MessageJoinerOptions) {
    this.nowMs = options.nowMs;
    this.log = options.log;
    this.partialTtlMs = options.partialTtlMs ?? DEFAULT_PARTIAL_TTL_MS;
    this.maxPartials = options.maxPartials ?? DEFAULT_MAX_PARTIALS;
    this.maxChunkCount = options.maxChunkCount ?? DEFAULT_MAX_CHUNK_COUNT;
  }

  *recv(chunk: Uint8Array): Generator<Uint8Array> {
    // A DataView rather than a Uint32Array: the latter throws on any frame shorter
    // than the header and on any byteOffset that is not 4-byte aligned, and reads
    // in host byte order on a field that is part of the wire format.
    if (chunk.byteLength < HEADER_SIZE) {
      yield chunk;
      return;
    }

    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (view.getUint32(0, true) !== MAGIC_WORD) {
      yield chunk;
      return;
    }

    const msgId = view.getUint32(4, true);
    const chunkCount = view.getUint32(8, true);
    const chunkIdx = view.getUint32(12, true);

    assert(chunkCount > 0, `Chunk header declares ${chunkCount} chunks!`);
    assert(
      chunkCount <= this.maxChunkCount,
      `Chunk header declares ${chunkCount} chunks, over the ${this.maxChunkCount} cap!`,
    );
    assert(
      chunkIdx < chunkCount,
      `Chunk index ${chunkIdx} is out of bounds for ${chunkCount} chunks!`,
    );

    // chunkCount is part of the key, so a sender that disagrees with itself about
    // the length of a message builds two partials, and neither completes.
    const key = `${msgId}_${chunkCount}`;
    this.expirePartials(key);

    const partial = mapPut(this.partials, key, () => ({
      chunkCount,
      lastUpdateMs: this.nowMs(),
      chunks: new Map<number, Uint8Array>(),
    }));
    partial.chunks.set(chunkIdx, chunk);
    partial.lastUpdateMs = this.nowMs();

    if (partial.chunks.size === chunkCount) {
      this.partials.delete(key);
      yield arrConcat(
        ...range(chunkCount).map((i) => partial.chunks.get(i)!.subarray(HEADER_SIZE)),
      );
    }
  }

  // Swept inline on every recv rather than on an interval: a timer would need
  // disposing, and a joiner is per-connection, so a silent peer's partials die
  // with the connection anyway.
  private expirePartials(incoming: string): void {
    const threshold = this.nowMs() - this.partialTtlMs;
    for (const [key, partial] of this.partials) {
      if (partial.lastUpdateMs < threshold) {
        this.drop(key, partial, 'expired');
      }
    }

    if (this.partials.size < this.maxPartials || this.partials.has(incoming)) return;

    // Map iteration is insertion-ordered and partials are never re-inserted, so
    // this evicts by creation time, not by last activity.
    for (const [key, partial] of this.partials) {
      this.drop(key, partial, 'evicted');
      if (this.partials.size < this.maxPartials) return;
    }
  }

  private drop(key: string, partial: Partial, reason: string): void {
    this.partials.delete(key);
    this.log?.warn('incompleteMessageDropped', {
      received: partial.chunks.size,
      expected: partial.chunkCount,
      reason,
    });
  }
}
