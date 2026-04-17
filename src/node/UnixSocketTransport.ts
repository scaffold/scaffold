// Protocol spec: docs/protocol/transport.md
//
// TransportPlugin for Unix domain sockets. Anonymous-only: used for local
// testing and bootstrap between processes on the same host. No cryptographic
// peer authentication.
//
// Wire format is length-prefixed: [4-byte big-endian length][payload].

import {
  AnonymousTransportDriver,
  ConnectionDriver,
  ConnectionProvider,
  TransportPlugin,
  TransportService,
} from '../interfaces/transport.ts';
import { ScopedLogger } from '../core/EventLog.ts';

export interface UnixSocketTransportOptions {
  socketPath?: string;
  logger?: ScopedLogger;
}

export class UnixSocketTransport implements TransportPlugin {
  readonly emitsProtocol = 'unix';
  readonly acceptsProtocols = ['unix'];

  readonly socketPath: string;
  private readonly logger?: ScopedLogger;

  constructor(options: UnixSocketTransportOptions | string = {}) {
    const opts = typeof options === 'string' ? { socketPath: options } : options;
    this.socketPath = opts.socketPath ?? `/tmp/scaffold-${crypto.randomUUID()}.sock`;
    this.logger = opts.logger;
  }

  start(driver: AnonymousTransportDriver): TransportService {
    const listener = Deno.listen({ path: this.socketPath, transport: 'unix' });
    const activeConns = new Set<Deno.Conn>();

    const acceptLoop = async () => {
      try {
        for await (const conn of listener) {
          const { provider, onConnClosed } = wrapDenoConn(conn, activeConns);
          const connDriver = driver.createAnonymousConnection(provider);
          wireConnectionDriver(conn, connDriver, onConnClosed);
        }
      } catch {
        // listener closed
      }
    };
    acceptLoop();

    const socketPath = this.socketPath;

    return {
      announceAddresses: () => {
        driver.broadcastAddress(socketPath);
      },
      dialAddress: (address: string) => {
        Deno.connect({ path: address, transport: 'unix' }).then(
          (conn) => {
            const { provider, onConnClosed } = wrapDenoConn(conn, activeConns);
            const connDriver = driver.createAnonymousConnection(provider);
            wireConnectionDriver(conn, connDriver, onConnClosed);
          },
          (err) => {
            this.logger?.warn('dialFailed', {
              address,
              error: String(err),
            });
          },
        );
      },
      stop: () => {
        try {
          listener.close();
        } catch { /* already closed */ }
        for (const conn of activeConns) {
          try {
            conn.close();
          } catch { /* already closed */ }
        }
        activeConns.clear();
        try {
          Deno.removeSync(socketPath);
        } catch { /* ok if already gone */ }
        return Promise.resolve();
      },
    };
  }
}

// -- Wire adapter -------------------------------------------------------

function wrapDenoConn(
  conn: Deno.Conn,
  activeConns: Set<Deno.Conn>,
): { provider: ConnectionProvider; onConnClosed: () => void } {
  activeConns.add(conn);

  const writeQueue: Uint8Array[] = [];
  let draining = false;
  let closed = false;

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (writeQueue.length > 0 && !closed) {
        const frame = writeQueue.shift()!;
        await writeAll(conn, frame);
      }
    } catch {
      doShutdown();
    }
    draining = false;
  };

  const doShutdown = () => {
    if (closed) return;
    closed = true;
    try {
      conn.close();
    } catch { /* already closed */ }
    activeConns.delete(conn);
  };

  const provider: ConnectionProvider = {
    sendReliable(data: Uint8Array): void {
      if (closed) return;
      const frame = new Uint8Array(4 + data.byteLength);
      new DataView(frame.buffer).setUint32(0, data.byteLength);
      frame.set(data, 4);
      writeQueue.push(frame);
      drain();
    },
    sendFast(data: Uint8Array): void {
      this.sendReliable(data);
    },
    shutdown(): void {
      doShutdown();
    },
  };

  return { provider, onConnClosed: doShutdown };
}

function wireConnectionDriver(
  conn: Deno.Conn,
  driver: ConnectionDriver,
  onConnClosed: () => void,
): void {
  (async () => {
    const headerBuf = new Uint8Array(4);
    try {
      while (true) {
        if (!await readFull(conn, headerBuf)) break;
        const len = new DataView(headerBuf.buffer).getUint32(0);
        const payload = new Uint8Array(len);
        if (!await readFull(conn, payload)) break;
        driver.recvData(payload);
      }
    } catch {
      // connection error
    }
    onConnClosed();
    driver.close();
  })();
}

async function readFull(conn: Deno.Conn, buf: Uint8Array): Promise<boolean> {
  let offset = 0;
  while (offset < buf.byteLength) {
    const n = await conn.read(buf.subarray(offset));
    if (n === null) return false;
    offset += n;
  }
  return true;
}

async function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const n = await conn.write(data.subarray(offset));
    offset += n;
  }
}
