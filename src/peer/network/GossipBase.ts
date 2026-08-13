import { Block } from '../../graph/types.ts';
import { ScopedLogger } from '../../logic/Logger.ts';
import { assert } from '../../util/functional.ts';
import { mapPut, multimapPut } from '../../util/map.ts';
import { Connection } from './types.ts';

export abstract class GossipBase {
  // Node-local reception state, keyed by block rather than stored on it.
  fromConnections = new WeakMap<Block, Connection[]>();
  toConnections = new WeakMap<Block, Set<Connection>>();

  // Set for the duration of a remote ingestion. BlockStore.ingest fires its listeners
  // synchronously before returning the block, so this is the only point at which the
  // source connection is knowable -- without it we echo every block to its sender.
  private ingestingFrom?: Connection;

  protected abstract getConnections(): Iterable<Connection>;
  protected abstract getAllBlocks(): Block[];
  protected abstract send(conn: Connection, raw: Uint8Array): void;
  protected abstract ingest(raw: Uint8Array): void;
  protected abstract getLogger(): ScopedLogger | undefined;

  recvData(conn: Connection, data: Uint8Array): void {
    assert(this.ingestingFrom === undefined, `Gossip ingestion re-entered!`);
    this.ingestingFrom = conn;
    try {
      this.ingest(data);
    } finally {
      this.ingestingFrom = undefined;
    }
  }

  // Driven by ingestion, so locally built and remote blocks take one path.
  floodBlock(block: Block): void {
    if (this.ingestingFrom !== undefined) {
      multimapPut(this.fromConnections, block, this.ingestingFrom);
    }
    this.sendBlock(block, this.getConnections());
  }

  // A peer that just connected knows nothing, and flooding only covers blocks
  // published from now on.
  backfill(conn: Connection): void {
    const blocks = this.getAllBlocks();
    this.getLogger()?.debug('backfill', { conn: conn.debugName, blocks: blocks.length });
    for (const block of blocks) {
      this.sendBlock(block, [conn]);
    }
  }

  private sendBlock(block: Block, conns: Iterable<Connection>): void {
    const from = this.fromConnections.get(block);
    const to = mapPut(this.toConnections, block, () => new Set<Connection>());

    for (const conn of conns) {
      if (!conn.isOpen || to.has(conn) || from?.includes(conn)) continue;
      to.add(conn);
      this.send(conn, block.raw);
      this.getLogger()?.debug('blockSent', {
        hash: block.hash.toHex(),
        conn: conn.debugName,
      });
    }
  }
}
