import { arrConcat } from './buffer.ts';
import { range } from './functional.ts';
import { mapPut } from './map.ts';

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

    const header32 = new Uint32Array([magicWord, this.nextIdx++, chunkCount, 0]);
    const header8 = new Uint8Array(header32.buffer);
    if (header8.byteLength !== headerSize) {
      throw new Error(`Invalid header length!`);
    }

    for (let i = 0; i < chunkCount; i++) {
      header32[3] = i;
      yield arrConcat(header8, packet.subarray(i * splitSize, (i + 1) * splitSize));
    }
  }
}

interface Message {
  total: number;
  lastUpdate: number;
  packets: Map<number, Uint8Array>;
}

export class MessageJoiner {
  private messages = new Map<string, Message>();

  constructor() {
    setInterval(() => {
      const threshold = Date.now() - 30000;
      for (const [key, val] of this.messages) {
        if (val.lastUpdate < threshold) {
          console.warn(`Dropping incomplete message with ${val.packets.size}/${val.total} parts`);
          this.messages.delete(key);
        }
      }
    }, 10000);
  }

  public *recv(packet: Uint8Array) {
    const words = new Uint32Array(packet.buffer, packet.byteOffset, 4);
    if (words[0] !== magicWord) {
      yield packet;
      return;
    }

    const key = `${words[1]}_${words[2]}`;
    const msg = mapPut<string, Message>(
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
        const parts = range(msg.total).map((i) => msg.packets.get(i)!.subarray(headerSize));
        yield arrConcat(...parts);
      }
    }
  }
}
