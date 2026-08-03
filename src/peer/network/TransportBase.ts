import { TimeProvider } from '../../Config.ts';
import {
  AnonymousTransportDriver,
  ConnectionDriver,
  ConnectionProvider,
  TransportPlugin,
  TransportService,
} from '../../interfaces/transport.ts';
import { ScopedLogger } from '../../logic/EventLog.ts';
import { assert, error } from '../../util/functional.ts';
import { MessageJoiner, MessageSplitter } from './MessageSplitter.ts';
import { Connection } from './types.ts';

type CloseReason = 'local' | 'remote' | 'stop';

export abstract class TransportBase {
  private transports: { plugin: TransportPlugin; service: TransportService }[] = [];
  private connections = new Set<Connection>();
  private nextConnectionIndex = 0;

  protected abstract onConnectionReady(conn: Connection): void;
  protected abstract onConnectionData(conn: Connection, data: Uint8Array): void;
  protected abstract onConnectionClosed(conn: Connection): void;
  protected abstract onAddressAnnounced(address: string, protocol?: string): void;

  protected abstract getLogger(): ScopedLogger | undefined;
  protected abstract getTimeProvider(): TimeProvider;

  startTransport(plugin: TransportPlugin, onAnnounce?: (signal: string) => void) {
    let service: TransportService;
    try {
      service = plugin.start(this.createAnonymousTransportDriver(plugin, onAnnounce));
    } catch (err) {
      this.getLogger()?.error('pluginStartFailed', {
        protocol: plugin.emitsProtocol,
        error: String(err),
      });
      throw err;
    }
    this.transports.push({ plugin, service });

    service.announceAddresses?.();
  }

  async stopTransport(plugin: TransportPlugin) {
    const idx = this.transports.findIndex((t) => t.plugin === plugin);
    if (idx === -1) {
      throw new Error(`Transport not found`);
    }

    const [{ service }] = this.transports.splice(idx, 1);
    await service.stop?.();
  }

  connect(url: URL): void {
    const protocol = url.protocol.replace(/:$/, '');

    for (const { plugin, service } of this.transports) {
      if (plugin.acceptsProtocols.includes(protocol) && service.dialAddress !== undefined) {
        this.getLogger()?.info('bootstrapDial', { protocol, address: url.href });
        service.dialAddress(url);
        return;
      }
    }

    this.getLogger()?.error('bootstrapUnroutable', { protocol, address: url.href });
    throw new Error(`No plugin accepts protocol ${protocol} and is dialable`);
  }

  getOpenConnections(): Set<Connection> {
    return this.connections;
  }

  sendReliable(conn: Connection, data: Uint8Array) {
    this.send(conn, data, false);
  }

  sendFast(conn: Connection, data: Uint8Array) {
    this.send(conn, data, true);
  }

  close(conn: Connection) {
    this.closeConnection(conn, 'local');
  }

  async stop() {
    for (const conn of [...this.connections]) {
      this.closeConnection(conn, 'stop');
    }

    const results = await Promise.allSettled(this.transports.map(({ service }) => service.stop()));
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        this.getLogger()?.warn('pluginStopFailed', {
          protocol: this.transports[i].plugin.emitsProtocol,
          error: String(result.reason),
        });
      }
    }
    this.transports = [];
  }

  private createAnonymousTransportDriver(
    plugin: TransportPlugin,
    onAnnounce?: (signal: string) => void,
  ): AnonymousTransportDriver {
    return {
      broadcastAddress: (address: string) => {
        this.getLogger()?.info('addressAnnounced', {
          protocol: plugin.emitsProtocol,
          address,
        });
        onAnnounce?.(address);
        this.onAddressAnnounced(address, plugin.emitsProtocol);
      },

      createAnonymousConnection: (provider: ConnectionProvider) => {
        return this.registerConnection(provider);
      },
    };
  }

  // A plugin must have its provider ready to send before calling this: onConnectionReady
  // runs before the driver is handed back, and may send immediately.
  private registerConnection(
    provider: ConnectionProvider,
    remotePublicKey?: Uint8Array,
  ): ConnectionDriver {
    const log = this.getLogger();
    const conn: Connection = {
      debugName: `conn-${this.nextConnectionIndex++}`,
      isOpen: true,
      provider,
      splitter: new MessageSplitter(provider.maxMsgSize ?? Infinity),
      joiner: new MessageJoiner({
        nowMs: () => this.getTimeProvider().nowMs(),
        log: log?.child('joiner'),
      }),
      remotePublicKey,
      sentCount: 0,
      recvCount: 0,
    };

    this.connections.add(conn);
    log?.info('connectionOpened', { conn: conn.debugName });
    this.onConnectionReady(conn);

    return {
      recvData: (data: Uint8Array) => this.recvData(conn, data),
      close: () => this.closeConnection(conn, 'remote'),
    };
  }

  private recvData(conn: Connection, data: Uint8Array): void {
    if (!conn.isOpen) {
      this.getLogger()?.debug('recvAfterClose', {
        conn: conn.debugName,
        bytes: data.byteLength,
      });
      return;
    }
    conn.recvCount++;

    let messages: Uint8Array[];
    try {
      messages = [...conn.joiner.recv(data)];
    } catch (err) {
      this.getLogger()?.warn('malformedChunk', { conn: conn.debugName, error: String(err) });
      this.close(conn);
      return;
    }

    for (const message of messages) {
      try {
        this.onConnectionData(conn, message);
      } catch (err) {
        // Kept open deliberately: ingestion can still throw on well-formed input
        // (see the claim-index gaps in TODO.v2.md), so a throw is not yet evidence
        // of a misbehaving peer.
        this.getLogger()?.warn('recvHandlerFailed', {
          conn: conn.debugName,
          bytes: message.byteLength,
          error: String(err),
        });
      }
    }
  }

  private send(conn: Connection, data: Uint8Array, fast: boolean): void {
    if (!conn.isOpen) {
      this.getLogger()?.debug('sendAfterClose', {
        conn: conn.debugName,
        bytes: data.byteLength,
      });
      return;
    }

    try {
      for (const chunk of conn.splitter.send(data)) {
        if (fast) {
          conn.provider.sendFast(chunk);
        } else {
          conn.provider.sendReliable(chunk);
        }
      }
    } catch (err) {
      this.getLogger()?.warn('sendFailed', { conn: conn.debugName, error: String(err) });
      this.close(conn);
      return;
    }

    conn.sentCount++;
  }

  private closeConnection(conn: Connection, reason: CloseReason): void {
    // Idempotent: a remote close arriving after a local one is the normal race.
    if (!conn.isOpen) return;
    conn.isOpen = false;
    this.connections.delete(conn);

    if (reason !== 'remote') {
      try {
        conn.provider.shutdown();
      } catch (err) {
        this.getLogger()?.warn('shutdownFailed', { conn: conn.debugName, error: String(err) });
      }
    }

    this.getLogger()?.info('connectionClosed', { conn: conn.debugName, reason });
    this.onConnectionClosed(conn);
  }
}
