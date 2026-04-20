// Protocol spec: docs/protocol/transport.md
//
// TransportPlugin for Unix domain sockets. Supports both anonymous mode
// (bootstrap, local testing) and authenticated mode (pubkey-identified
// peers). There is no cryptographic authentication at the socket layer:
// each authenticated handshake mints a fresh per-session listener at a
// random filesystem path, and that path itself is the shared secret,
// delivered to the dialing peer via Scaffold's encrypted signaling mesh.
//
// Wire format: length-prefixed [4-byte big-endian length][payload].
//
// Authenticated handshake:
//   1. Initiator's initializeAuthenticatedTransport() schedules a microtask.
//      If recvSignal has not fired by the time it runs (initiator role),
//      the plugin mints a dedicated socket path, opens a listener on it,
//      and emits `unix:<authPath>` via driver.sendSignal.
//   2. The receiver's initializeAuthenticatedTransport() is called, then
//      session.recvSignal(signal) is invoked synchronously by the
//      TransportManager. recvSignal sets mode='recv' (preempting the
//      microtask's send-path), parses the signal, and dials the remote
//      auth socket. The new connection is handed to the driver as
//      authenticated.
//   3. The initiator's auth listener accepts the first connection,
//      promotes it via driver.createAuthenticatedConnection, then closes
//      the listener and removes the socket file.
//
// The main listener (this.socketPath) remains anonymous-only and preserves
// its prior behavior: every accepted connection becomes an anonymous
// ConnectionDriver before any data flows.

import {
  AnonymousTransportDriver,
  AuthenticatedTransportDriver,
  ConnectionDriver,
  ConnectionProvider,
  TransportPlugin,
  TransportService,
  TransportSession,
} from '../interfaces/transport.ts';
import { ScopedLogger } from '../core/EventLog.ts';

export interface UnixSocketTransportOptions {
  socketPath?: string;
  logger?: ScopedLogger;
  /**
   * Directory used to mint per-handshake authenticated socket paths.
   * Defaults to the directory containing `socketPath`, or /tmp.
   */
  authPathDir?: string;
}

export class UnixSocketTransport implements TransportPlugin {
  readonly emitsProtocol = 'unix';
  readonly acceptsProtocols = ['unix'];

  readonly socketPath: string;
  private readonly logger?: ScopedLogger;
  private readonly authPathDir: string;

  constructor(options: UnixSocketTransportOptions | string = {}) {
    const opts = typeof options === 'string' ? { socketPath: options } : options;
    this.socketPath = opts.socketPath ?? `/tmp/scaffold-${crypto.randomUUID()}.sock`;
    this.logger = opts.logger;
    this.authPathDir = opts.authPathDir ?? defaultAuthDir(this.socketPath);
  }

  start(anonymousDriver: AnonymousTransportDriver): TransportService {
    const listener = Deno.listen({ path: this.socketPath, transport: 'unix' });
    const activeConns = new Set<Deno.Conn>();
    const authListeners = new Set<Deno.Listener>();
    const socketPath = this.socketPath;
    const authPathDir = this.authPathDir;
    const logger = this.logger;

    const acceptLoop = async () => {
      try {
        for await (const conn of listener) {
          const { provider, onConnClosed } = wrapDenoConn(conn, activeConns);
          const connDriver = anonymousDriver.createAnonymousConnection(provider);
          wireConnectionDriver(conn, connDriver, onConnClosed);
        }
      } catch {
        // listener closed
      }
    };
    acceptLoop();

    return {
      announceAddresses: () => {
        anonymousDriver.broadcastAddress(socketPath);
      },

      dialAddress: (address: string) => {
        // Anonymous bootstrap dial. Authenticated dials go through the
        // session's recvSignal handler, not this entry point.
        Deno.connect({ path: address, transport: 'unix' }).then(
          (conn) => {
            const { provider, onConnClosed } = wrapDenoConn(conn, activeConns);
            const connDriver = anonymousDriver.createAnonymousConnection(provider);
            wireConnectionDriver(conn, connDriver, onConnClosed);
          },
          (err) => {
            logger?.warn('dialFailed', { address, error: String(err) });
          },
        );
      },

      initializeAuthenticatedTransport: (
        driver: AuthenticatedTransportDriver,
      ): TransportSession => {
        let mode: 'init' | 'recv' | undefined;
        let sessionListener: Deno.Listener | undefined;
        let sessionPath: string | undefined;

        // Defer the initiator-side work. If recvSignal fires synchronously
        // (receiver role), mode becomes 'recv' first and the microtask
        // skips its send-path.
        queueMicrotask(() => {
          if (mode !== undefined) return;
          mode = 'init';
          sessionPath = mintAuthPath(authPathDir);
          try {
            sessionListener = Deno.listen({ path: sessionPath, transport: 'unix' });
          } catch (err) {
            logger?.warn('authListenFailed', { path: sessionPath, error: String(err) });
            return;
          }
          authListeners.add(sessionListener);
          const listenerRef = sessionListener;
          const pathRef = sessionPath;
          (async () => {
            try {
              const conn = await listenerRef.accept();
              const { provider, onConnClosed } = wrapDenoConn(conn, activeConns);
              const connDriver = driver.createAuthenticatedConnection(provider);
              wireConnectionDriver(conn, connDriver, onConnClosed);
            } catch {
              // listener closed or accept errored
            }
            closeAuthListener(listenerRef, pathRef, authListeners);
          })();
          driver.sendSignal(`unix:${sessionPath}`);
        });

        return {
          recvSignal: (signal: string) => {
            if (mode === undefined) mode = 'recv';
            if (mode !== 'recv') return;

            const path = parseUnixSignal(signal);
            if (!path) {
              logger?.warn('authSignalMalformed', { signal });
              return;
            }

            Deno.connect({ path, transport: 'unix' }).then(
              (conn) => {
                const { provider, onConnClosed } = wrapDenoConn(conn, activeConns);
                const connDriver = driver.createAuthenticatedConnection(provider);
                wireConnectionDriver(conn, connDriver, onConnClosed);
              },
              (err) => {
                logger?.warn('authDialFailed', { path, error: String(err) });
              },
            );
          },
          close: () => {
            if (sessionListener && sessionPath) {
              closeAuthListener(sessionListener, sessionPath, authListeners);
            }
          },
        };
      },

      stop: () => {
        try {
          listener.close();
        } catch { /* already closed */ }
        for (const authListener of authListeners) {
          try {
            authListener.close();
          } catch { /* already closed */ }
        }
        authListeners.clear();
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
        if (len > 0 && !await readFull(conn, payload)) break;
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

// -- Auth helpers -------------------------------------------------------

function defaultAuthDir(socketPath: string): string {
  const idx = socketPath.lastIndexOf('/');
  return idx > 0 ? socketPath.slice(0, idx) : '/tmp';
}

function mintAuthPath(dir: string): string {
  const hex = randomHex(16);
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir;
  return `${base}/scaffold-auth-${hex}.sock`;
}

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function parseUnixSignal(signal: string): string | null {
  const scheme = 'unix:';
  if (!signal.startsWith(scheme)) return null;
  const path = signal.slice(scheme.length);
  return path.length > 0 ? path : null;
}

function closeAuthListener(
  listener: Deno.Listener,
  path: string,
  authListeners: Set<Deno.Listener>,
): void {
  authListeners.delete(listener);
  try {
    listener.close();
  } catch { /* already closed */ }
  try {
    Deno.removeSync(path);
  } catch { /* already gone */ }
}
