// Protocol spec: docs/protocol/transport.md
//
// TransportPlugin for the server side of a WebSocket connection. Deno-only:
// uses Deno.serve to open a listening port.
//
// Emits 'websocket' signals; accepts no protocols. The service owns a single
// Deno.serve listener across its lifetime; each authenticated session mints
// a fresh per-connection token and routes the matching WS upgrade to the
// session that issued it.

import {
  AnonymousTransportDriver,
  AuthenticatedTransportDriver,
  ConnectionDriver,
  ConnectionProvider,
  TransportPlugin,
  TransportService,
  TransportSession,
} from '../../src/interfaces/transport.ts';
import { assert } from '../../src/util/functional.ts';
import { isUnshared } from '../util.ts';

interface PendingAuthConn {
  driver: AuthenticatedTransportDriver;
  session: WeakRef<TransportSession> | null;
}

export class WebsocketServerTransport implements TransportPlugin {
  readonly emitsProtocol = 'websocket';
  readonly acceptsProtocols: string[] = [];

  constructor(
    private readonly config: {
      port?: number;
      publicHostnames?: string[];
    } = {},
  ) {}

  start(anonymousDriver: AnonymousTransportDriver): TransportService {
    const port = this.config.port ?? 8314;
    const pending = new Map<string, PendingAuthConn>();

    const listenResolver = Promise.withResolvers<{ hostname: string; port: number }>();

    const originsPromise = (async () => {
      const listen = await listenResolver.promise;
      const origins = new Set<string>();
      origins.add(`ws://${listen.hostname}:${listen.port}`);
      origins.add(`ws://127.0.0.1:${listen.port}`);
      for (const host of this.config.publicHostnames ?? []) {
        origins.add(`ws://${host}:${listen.port}`);
      }
      return [...origins];
    })();

    const server = Deno.serve({
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

    return {
      announceAddresses: () => {
        originsPromise.then((origins) => {
          for (const origin of origins) {
            anonymousDriver.broadcastAddress(`${origin}/`);
          }
        });
      },
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
    shutdown: () => {
      try {
        socket.close();
      } catch { /* ignore */ }
    },
  };
}

function wireSocket(socket: WebSocket, driver: ConnectionDriver): void {
  socket.onmessage = (e) => driver.recvData(new Uint8Array(e.data as ArrayBuffer));
  socket.onclose = () => driver.close();
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
