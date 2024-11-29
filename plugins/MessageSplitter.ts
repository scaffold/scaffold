import { arrConcat } from '../src/util/buffer.ts';
import { range } from '../src/util/functional.ts';
import { mapPut } from '../src/util/map.ts';

const magicWord = 57;
const headerSize = 16;

export class MessageSplitter {
  private nextIdx = 0;

  constructor(private chunkSize: number) {}

  public *send(packet: Uint8Array) {
    if (
      packet.byteLength <= this.chunkSize &&
      (packet[0] !== ((magicWord >>> 0) & 0xFF) ||
        packet[1] !== ((magicWord >>> 8) & 0xFF) ||
        packet[2] !== ((magicWord >>> 16) & 0xFF) ||
        packet[3] !== ((magicWord >>> 24) & 0xFF))
    ) {
      yield packet;
      return;
    }

    const splitSize = this.chunkSize - headerSize;
    if (splitSize <= 0) {
      throw new Error(`Chunk size is too small!!!`);
    }
    const chunkCount = Math.ceil(packet.byteLength / splitSize);

    const header32 = new Uint32Array([
      magicWord,
      this.nextIdx++,
      chunkCount,
      0,
    ]);
    const header8 = new Uint8Array(header32.buffer);
    if (header8.byteLength !== headerSize) {
      throw new Error(`Invalid header length!`);
    }

    for (let i = 0; i < chunkCount; i++) {
      header32[3] = i;
      yield arrConcat(
        header8,
        packet.subarray(i * splitSize, (i + 1) * splitSize),
      );
    }
  }
}

export class MessageJoiner {
  private messages = new Map<
    string,
    { total: number; lastUpdate: number; packets: Map<number, ArrayBuffer> }
  >();

  constructor() {
    setInterval(() => {
      const threshold = Date.now() - 30000;
      for (const [key, val] of this.messages) {
        if (val.lastUpdate < threshold) {
          console.warn(
            `Dropping incomplete message with ${val.packets.size}/${val.total} parts`,
          );
          this.messages.delete(key);
        }
      }
    }, 10000);
  }

  public *recv(packet: ArrayBuffer) {
    const words = new Uint32Array(packet, 0, 4);
    if (words[0] !== magicWord) {
      yield new Uint8Array(packet);
      return;
    }

    const key = `${words[1]}_${words[2]}`;
    const msg = mapPut(
      this.messages,
      key,
      () => ({ total: words[2], lastUpdate: 0, packets: new Map() }),
    );

    const chunkIdx = words[3];
    if (chunkIdx < msg.total) {
      msg.packets.set(chunkIdx, packet);
      msg.lastUpdate = Date.now();

      if (msg.packets.size === msg.total) {
        this.messages.delete(key);
        const parts = range(msg.total).map((i) =>
          new Uint8Array(msg.packets.get(i), headerSize)
        );
        yield arrConcat(...parts);
      }
    }
  }
}
