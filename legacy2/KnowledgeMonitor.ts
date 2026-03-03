import { Connection } from './Connection.ts';
import { assert } from './util/functional.ts';
import { Hash, HASH_SIZE, HashPrimitive } from './util/Hash.ts';

export class KnowledgeMonitor {
  private recvDelays = new Map<HashPrimitive, number>();

  constructor(private conn: Connection) {}

  has(hash: Hash) {
    return this.recvDelays.has(hash.toPrimitive());
  }

  ingest(data: Uint8Array, at: number) {
    assert(data.byteLength % HASH_SIZE === 0);
    for (let i = 0; i < data.byteLength; i += HASH_SIZE) {
      this.recvDelays.set(Hash.fromBytes(data.subarray(i, i + HASH_SIZE)).toPrimitive(), at);
    }
  }
}
