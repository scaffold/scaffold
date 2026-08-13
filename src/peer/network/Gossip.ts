import { Context } from '../../Context.ts';
import { BlockStore } from '../../graph/BlockStore.ts';
import { AtomSource, Block } from '../../graph/types.ts';
import { ScopedLogger } from '../../logic/Logger.ts';
import { GossipBase } from './GossipBase.ts';
import { Transport } from './Transport.ts';
import { Connection } from './types.ts';

export class GossipConfig {
  // Off makes a peer answer-only: it still floods what it ingests from now on, but a
  // newly connected peer gets nothing it did not ask for.
  backfillOnConnect = false;
}

export class Gossip extends GossipBase implements Disposable {
  private disposeController = new AbortController();

  constructor(private ctx: Context) {
    super();

    const signal = this.disposeController.signal;
    const transport = this.ctx.get(Transport);

    transport.onData((conn, data) => this.recvData(conn, data), signal);
    transport.onConnection((conn) => {
      if (this.ctx.get(GossipConfig).backfillOnConnect) this.backfill(conn);
    }, signal);
    this.ctx.get(BlockStore).onIngest((block) => this.floodBlock(block), signal);
  }

  [Symbol.dispose]() {
    this.disposeController.abort();
  }

  protected override getConnections(): Iterable<Connection> {
    return this.ctx.get(Transport).getOpenConnections();
  }

  protected override getAllBlocks(): Block[] {
    return this.ctx.get(BlockStore).getAll();
  }

  protected override send(conn: Connection, raw: Uint8Array): void {
    this.ctx.get(Transport).sendReliable(conn, raw);
  }

  protected override ingest(raw: Uint8Array): void {
    this.ctx.get(BlockStore).ingest({
      source: AtomSource.Remote,
      receivedAt: this.ctx.config.timeProvider.nowMs(),
      raw,
    });
  }

  protected override getLogger(): ScopedLogger | undefined {
    return this.ctx.logger('gossip');
  }
}
