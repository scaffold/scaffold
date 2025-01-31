import { Connection } from './Connection.ts';
import { FactType } from './FactMeta.ts';
import { FactService } from './FactService.ts';
import { Hash, HASH_SIZE } from './util/Hash.ts';
import { ConnectionService } from './ConnectionService.ts';

export class KnowledgeAnnouncer {
  private queue: Hash[] = [];
  private timeoutHdl?: number;

  constructor(private conn: Connection) {}

  add(hash: Hash) {
    this.queue.push(hash);

    if (this.timeoutHdl === undefined) {
      const delay = this.conn.ctx.config.entropyProvider.randomNumber() * 100 + 500;
      this.timeoutHdl = this.conn.ctx.config.timeProvider.setTimeout(() => {
        this.timeoutHdl = undefined;
        this.publish();
      }, delay);
    }
  }

  private publish() {
    const data = new Uint8Array(this.queue.length * HASH_SIZE);
    for (let i = 0; i < this.queue.length; i++) {
      data.set(this.queue[i].toBytes(), i * HASH_SIZE);
    }

    this.queue = [];

    this.conn.ctx.get(FactService).emit(
      data,
      { encode: (x) => x },
      FactType.PeerInfo,
      this.conn.ctx.get(ConnectionService).getAll(),
    );
  }
}
