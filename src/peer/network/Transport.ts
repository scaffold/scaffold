import { TimeProvider } from '../../Config.ts';
import { Context } from '../../Context.ts';
import { ScopedLogger } from '../../logic/EventLog.ts';
import { arrCall } from '../../util/array.ts';
import { assert } from '../../util/functional.ts';
import { TransportBase } from './TransportBase.ts';
import { Connection } from './types.ts';

type ConnectionListener = (conn: Connection) => void;
type DataListener = (conn: Connection, data: Uint8Array) => void;

function subscribe<Cb>(listeners: Set<Cb>, cb: Cb, signal: AbortSignal): void {
  if (signal.aborted) return;
  listeners.add(cb);
  signal.addEventListener('abort', () => assert(listeners.delete(cb)));
}

// Transport sits below Gossip: Gossip queries it and subscribes to it, and it never
// reaches back up. That is what keeps the two acyclic.
export class Transport extends TransportBase implements AsyncDisposable {
  private connectionListeners = new Set<ConnectionListener>();
  private dataListeners = new Set<DataListener>();
  private closedListeners = new Set<ConnectionListener>();

  constructor(private ctx: Context) {
    super();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }

  run() {
    for (const plugin of this.ctx.config.transportPlugins) {
      this.startTransport(plugin);
    }

    for (const url of this.ctx.config.bootstrapUrls) {
      this.connect(url instanceof URL ? url : new URL(url));
    }
  }

  onConnection(cb: ConnectionListener, signal: AbortSignal): void {
    subscribe(this.connectionListeners, cb, signal);
  }

  onData(cb: DataListener, signal: AbortSignal): void {
    subscribe(this.dataListeners, cb, signal);
  }

  onClosed(cb: ConnectionListener, signal: AbortSignal): void {
    subscribe(this.closedListeners, cb, signal);
  }

  protected override onConnectionReady(conn: Connection): void {
    arrCall(this.connectionListeners, conn);
  }

  protected override onConnectionData(conn: Connection, data: Uint8Array): void {
    arrCall(this.dataListeners, conn, data);
  }

  protected override onConnectionClosed(conn: Connection): void {
    arrCall(this.closedListeners, conn);
  }

  protected override onAddressAnnounced(_address: string, _protocol?: string): void {
    // Logged and recorded in announcedAddresses by the base; nothing consumes it yet.
  }

  protected override getLogger(): ScopedLogger | undefined {
    return this.ctx.logger('transport');
  }

  protected override getTimeProvider(): TimeProvider {
    return this.ctx.config.timeProvider;
  }
}
