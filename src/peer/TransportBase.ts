import {
  AnonymousTransportDriver,
  ConnectionProvider,
  TransportPlugin,
  TransportService,
} from '../interfaces/transport.ts';
import { todo } from '../util/functional.ts';

interface Connection {}

export abstract class TransportBase {
  private transports: { plugin: TransportPlugin; service: TransportService }[] = [];
  private services = new Map<TransportPlugin, TransportService>();

  protected abstract onConnectionReady(conn: Connection): void;
  protected abstract onConnectionData(conn: Connection, data: Uint8Array): void;
  protected abstract onConnectionClosed(conn: Connection): void;

  constructor(plugins: TransportPlugin[], bootstrapUrls: URL[]) {
    this.bootstrapPlugins(plugins);
    this.bootstrapConnections(bootstrapUrls);
  }

  sendReliable(conn: Connection, data: Uint8Array): void {
  }

  sendFast(conn: Connection, data: Uint8Array): void {
  }

  close(conn: Connection): void {
  }

  private bootstrapPlugins(plugins: TransportPlugin[]) {
    for (const plugin of plugins) {
      this.transports.push({
        plugin,
        service: plugin.start(this.createAnonymousTransportDriver()),
      });
    }
  }

  private bootstrapConnections(bootstrapUrls: URL[]) {
    nextBootstrapUrl: for (const url of bootstrapUrls) {
      const protocol = url.protocol.replace(/:$/, '');

      for (const { plugin, service } of this.transports) {
        if (plugin.acceptsProtocols.includes(protocol) && service.dialAddress !== undefined) {
          service.dialAddress(url.host);
          continue nextBootstrapUrl;
        }
      }

      throw new Error(`No plugin accepts protocol ${protocol} and is dialable`);
    }
  }

  private createAnonymousTransportDriver(): AnonymousTransportDriver {
    return {
      broadcastAddress: (signal: string) => {},

      createAnonymousConnection: (connection: ConnectionProvider) => {
        return todo();
      },
    };
  }
}
