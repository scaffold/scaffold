// Protocol spec: docs/protocol/transport.md
//
// TransportPlugin for the client side of a WebSocket connection. Browser-safe:
// uses the global WebSocket constructor, which is available in both browser
// and Deno runtimes.
//
// Accepts 'websocket' signals; does not emit. Supports both anonymous bootstrap
// (dial a bare wss:// URL) and authenticated handshake (dial a URL delivered
// through the encrypted signaling channel by a WebSocket server peer).

import {
  AnonymousTransportDriver,
  AuthenticatedTransportDriver,
  ConnectionProvider,
  TransportPlugin,
  TransportService,
  TransportSession,
} from '../src/interfaces/transport.ts';
import { assert } from '../src/util/functional.ts';
import { isUnshared } from './util.ts';

export class WebsocketClientTransport implements TransportPlugin {
  readonly emitsProtocol = undefined;
  readonly acceptsProtocols = ['websocket'];

  start(anonymousDriver: AnonymousTransportDriver): TransportService {
    return {
      dialAddress: (address: string) => {
        dial(address, (conn) => anonymousDriver.createAnonymousConnection(conn));
      },
      initializeAuthenticatedTransport: (
        driver: AuthenticatedTransportDriver,
      ): TransportSession => {
        let socket: WebSocket | undefined;
        return {
          recvSignal: (signal: string) => {
            if (socket) return; // already dialing / connected
            socket = dial(signal, (conn) => driver.createAuthenticatedConnection(conn));
          },
          close: () => {
            try {
              socket?.close();
            } catch { /* ignore */ }
          },
        };
      },
      stop: async () => {
        // No global state to clean up
      },
    };
  }
}

// -- Dialer -------------------------------------------------------------

function dial(
  url: string,
  createDriver: (
    conn: ConnectionProvider,
  ) => { recvData: (data: Uint8Array) => void; close: () => void },
): WebSocket {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';

  socket.onopen = () => {
    const provider: ConnectionProvider = {
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

    const connDriver = createDriver(provider);

    socket.onmessage = (e) => connDriver.recvData(new Uint8Array(e.data as ArrayBuffer));
    socket.onclose = () => connDriver.close();
  };

  return socket;
}
