// Protocol spec: docs/protocol/transport.md
//
// TransportPlugin for the server side of a WebSocket connection. Deno-only:
// uses Deno.serve to open a listening port.
//
// Emits 'websocket' signals; accepts no protocols. The service owns a single
// Deno.serve listener across its lifetime; each authenticated session mints
// a fresh per-connection token and routes the matching WS upgrade to the
// session that issued it.

import { Logger } from '../../src/interfaces/LoggingProvider.ts';
import {
  AnonymousTransportDriver,
  AuthenticatedTransportDriver,
  ConnectionDriver,
  ConnectionProvider,
  TransportPlugin,
  TransportService,
  TransportSession,
} from '../../src/interfaces/transport.ts';
import { assert, error } from '../../src/util/functional.ts';
import { closeAndFlush, isUnshared } from '../util.ts';

export interface WebsocketServerTransportConfig {
  hostname?: string;
  port?: number;
  publicOrigins?: string[];
}

interface PendingAuthConn {
  driver: AuthenticatedTransportDriver;
  session: WeakRef<TransportSession> | null;
}

export class WebsocketServerTransport implements TransportPlugin {
  name = 'WebsocketServerTransport';
  emitsProtocol = 'websocket';
  acceptsProtocols: string[] = [];

  constructor(private config: WebsocketServerTransportConfig, private log?: Logger) {}

  start(anonymousDriver: AnonymousTransportDriver): TransportService {
    const port = this.config.port ?? 8314;
    const pending = new Map<string, PendingAuthConn>();

    const listenResolver = Promise.withResolvers<{ hostname: string; port: number }>();

    const originsPromise = (async () => {
      const listen = await listenResolver.promise;
      this.log?.info(`Listening on ws://${listen.hostname}:${listen.port}`);

      const origins = this.config.publicOrigins ?? [`ws://${listen.hostname}:${listen.port}`];
      return origins.map(normalizeOrigin);
    })();

    const server = Deno.serve({
      hostname: this.config.hostname,
      port,
      onListen: listenResolver.resolve,
      handler: (req) => {
        if (req.headers.get('upgrade') !== 'websocket') {
          return new Response(null, { status: 501 });
        }

        const url = new URL(req.url);
        const token = url.searchParams.get('token');

        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.binaryType = 'arraybuffer';

        if (token && pending.has(token)) {
          const entry = pending.get(token)!;
          pending.delete(token);

          socket.onopen = () => {
            const provider = wrapSocket(socket);
            const connDriver = entry.driver.createAuthenticatedConnection(provider);
            wireSocket(socket, connDriver);
          };
        } else {
          // Anonymous connection (bootstrap / relay)
          socket.onopen = () => {
            const provider = wrapSocket(socket);
            const connDriver = anonymousDriver.createAnonymousConnection(provider);
            wireSocket(socket, connDriver);
          };
        }

        return response;
      },
    });

    originsPromise.then((origins) =>
      anonymousDriver.announceAddresses(origins.map((x) => new URL(x)))
    );

    return {
      initializeAuthenticatedTransport: (
        driver: AuthenticatedTransportDriver,
      ): TransportSession => {
        // Mint a fresh token and register it. Emit a URL containing it via sendSignal.
        const token = randomTokenHex();
        pending.set(token, { driver, session: null });

        originsPromise.then((origins) => {
          for (const origin of origins) {
            driver.sendSignal(`${origin}/?token=${token}`);
          }
        });

        const session: TransportSession = {
          recvSignal: (_signal: string) => {
            // The server doesn't consume signals from the client -- the client
            // connects to the URL directly once it has it.
          },
          close: () => {
            pending.delete(token);
          },
        };
        return session;
      },
      stop: async () => {
        pending.clear();
        try {
          await server.shutdown();
        } catch { /* already stopped */ }
      },
    };
  }
}

// -- Socket wire adapter -----------------------------------------------

function wrapSocket(socket: WebSocket): ConnectionProvider {
  return {
    sendReliable: (data: Uint8Array) => {
      assert(isUnshared(data)); // WebSocket.send doesn't support SharedArrayBuffer
      socket.send(data);
    },
    sendFast: (data: Uint8Array) => {
      assert(isUnshared(data)); // WebSocket.send doesn't support SharedArrayBuffer
      socket.send(data);
    },
    shutdown: () => closeAndFlush(socket),
  };
}

function wireSocket(socket: WebSocket, driver: ConnectionDriver): void {
  socket.onmessage = (e) => driver.recvData(new Uint8Array(e.data as ArrayBuffer));
  socket.onclose = () => driver.close();
}

// -- Origin helper ------------------------------------------------------

function normalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    error(`publicOrigins entry is not a valid URL: ${raw}`);
  }
  assert(
    url.protocol === 'ws:' || url.protocol === 'wss:',
    `publicOrigins entry must use ws: or wss:, got: ${raw}`,
  );
  assert(
    url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '',
    `publicOrigins entry must be a bare origin with no path or credentials, got: ${raw}`,
  );
  return url.origin;
}

// -- Token helper -------------------------------------------------------

function randomTokenHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}
