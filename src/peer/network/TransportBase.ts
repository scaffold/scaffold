import { TimeProvider } from '../../Config.ts';
import {
  AnonymousTransportDriver,
  ConnectionDriver,
  ConnectionProvider,
  TransportPlugin,
  TransportService,
} from '../../interfaces/transport.ts';
import { ScopedLogger } from '../../logic/Logger.ts';
import { assert } from '../../util/functional.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';
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

  protected abstract getLogger(): ScopedLogger | undefined;
  protected abstract getTimeProvider(): TimeProvider;

  startTransport(plugin: TransportPlugin, onAnnounce?: (url: URL) => void) {
    const service = plugin.start(this.createAnonymousTransportDriver(plugin, onAnnounce));

    if ((plugin.acceptsUrl === undefined) !== (service.dialAddress === undefined)) {
      throw new Error(
        `Transport plugin ${plugin.name} must define either both acceptsUrl and dialAddress, or neither`,
      );
    }

    this.transports.push({ plugin, service });
  }

  async stopTransport(plugin: TransportPlugin) {
    const idx = this.transports.findIndex((t) => t.plugin === plugin);
    if (idx === -1) {
      throw new Error(`Transport not found`);
    }
    const [{ service }] = this.transports.splice(idx, 1);

    // TODO: Better error handling?
    await service.stopAccepting?.();
    for (const conn of this.connections) {
      if (conn.plugin === plugin) {
        await this.closeConnection(conn, 'local');
      }
    }
    await service.shutdown?.();
  }

  connect(url: URL): void {
    for (const { plugin, service } of this.transports) {
      if (plugin.acceptsUrl?.(url) && service.dialAddress !== undefined) {
        this.getLogger()?.info('bootstrapDial', { url: url.toString() });
        service.dialAddress(url);
        return;
      }
    }

    this.getLogger()?.error('bootstrapUnroutable', { url });
    throw new Error(`No plugin accepts url ${url} and is dialable`);
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
    return this.closeConnection(conn, 'local');
  }

  async stop() {
    const results = await Promise.allSettled(
      this.transports.map(({ plugin }) => this.stopTransport(plugin)),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        this.getLogger()?.warn('stopTransportFailed', { error: String(result.reason) });
      }
    }

    assert(this.transports.length === 0);
  }

  private createAnonymousTransportDriver(
    plugin: TransportPlugin,
    onAnnounce?: (url: URL, unannounce: AbortSignal) => void,
  ): AnonymousTransportDriver {
    let announcedUrls: { url: URL; unannounce: AbortController }[] = [];

    return {
      announceAddresses: (urls: URL[]) => {
        this.getLogger()?.info('addressesAnnounced', {
          protocol: plugin.emitsProtocol,
          urls: urls.map((x) => x.toString()),
        });

        const newUrls = new Map(urls.map((u) => [u.toString(), u]));

        announcedUrls = announcedUrls.filter((x) => {
          if (newUrls.delete(x.url.toString())) {
            return true;
          } else {
            x.unannounce.abort();
            return false;
          }
        });

        for (const url of newUrls.values()) {
          const unannounce = new AbortController();
          announcedUrls.push({ url, unannounce });
          onAnnounce?.(url, unannounce.signal);
        }
      },

      createAnonymousConnection: (provider: ConnectionProvider) =>
        this.registerConnection(plugin, provider),
    };
  }

  // A plugin must have its provider ready to send before calling this: onConnectionReady
  // runs before the driver is handed back, and may send immediately.
  private registerConnection(
    plugin: TransportPlugin,
    provider: ConnectionProvider,
    remotePublicKey?: Uint8Array,
  ): ConnectionDriver {
    const log = this.getLogger();
    const conn: Connection = {
      debugName: `conn-${this.nextConnectionIndex++}`,
      plugin,
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

  // Returns the provider's flush so `stop` can await it; fire-and-forget callers
  // (`close`, a remote hangup) ignore it and keep their synchronous shape.
  private closeConnection(conn: Connection, reason: CloseReason): MaybePromise<void> {
    // Idempotent: a remote close arriving after a local one is the normal race.
    if (!conn.isOpen) return;
    conn.isOpen = false;
    this.connections.delete(conn);

    let shutdown: MaybePromise<void> = undefined;
    if (reason !== 'remote') {
      try {
        shutdown = conn.provider.shutdown();
      } catch (err) {
        this.getLogger()?.warn('shutdownFailed', { conn: conn.debugName, error: String(err) });
      }
    }

    this.getLogger()?.info('connectionClosed', { conn: conn.debugName, reason });
    this.onConnectionClosed(conn);

    return shutdown;
  }
}
