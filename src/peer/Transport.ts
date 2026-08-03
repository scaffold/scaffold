import { Context } from '../Context.ts';
import { BlockStore } from '../graph/BlockStore.ts';
import { Block } from '../graph/types.ts';
import { TransportBase } from './TransportBase.ts';

export class Transport extends TransportBase implements Disposable {
  private disposeController = new AbortController();

  constructor(private ctx: Context) {
    super(
      ctx.config.transportPlugins,
      ctx.config.bootstrapUrls.map((x) => x instanceof URL ? x : new URL(x)),
    );

    this.ctx.get(BlockStore).onIngest(
      (block) => this.ingestBlock(block),
      this.disposeController.signal,
    );
  }

  [Symbol.dispose]() {
    this.disposeController.abort();
  }

  protected override onConnectionReady(conn: Connection): void {
  }

  protected override onConnectionData(conn: Connection, data: Uint8Array): void {
  }

  protected override onConnectionClosed(conn: Connection): void {
  }

  private ingestBlock(block: Block) {
  }
}
