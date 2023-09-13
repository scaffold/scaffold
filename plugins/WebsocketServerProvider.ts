import { serve } from 'std-latest/http/mod.ts';
import NetworkProvider, { ConnectionProvider } from '~/sbl/NetworkProvider.ts';

export default class WebsocketServerProvider implements NetworkProvider {
  public protocolName = 'websocket';

  public createServer(
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ) {
    const port = 8314;

    // Don't await here; I think serve only resolves once the server closes.
    serve(
      (req: Request) => {
        if (req.headers.get('upgrade') !== 'websocket') {
          return new Response(null, { status: 501 });
        }
        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.binaryType = 'arraybuffer';

        socket.addEventListener('open', () =>
          onNewConn({
            sendReliable: (data: Uint8Array) => socket.send(data),
            sendFast: (data: Uint8Array) => socket.send(data),
            onRecv: (handler: (data: Uint8Array) => void) =>
              socket.addEventListener('message', (e) =>
                handler(new Uint8Array(e.data))),
            close: () =>
              socket.close(),
            onClose: (handler: () => void) =>
              socket.addEventListener('close', () => handler()),
          }));

        return response;
      },
      { port },
    );

    [
      '127.0.0.1',
      fetch('https://api.ipify.org/?format=json').then((resp) => resp.json())
        .then((body) => body.ip),
    ].forEach((host) =>
      Promise.resolve(host).then((host) => onListen(`ws://${host}:${port}`))
    );
  }

  public createClient(
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ) {
    let connected = false;
    const clientAttempts: WebSocket[] = [];

    return {
      tryConnect: (spec: string) => {
        const socket = new WebSocket(spec);
        socket.binaryType = 'arraybuffer';
        clientAttempts.push(socket);
        socket.addEventListener(
          'open',
          () => {
            if (connected) {
              return;
            } else {
              connected = true;
            }

            // Close any other attempted clientAttempts
            clientAttempts.forEach((s) => s.close());

            onNewConn({
              sendReliable: (data: Uint8Array) => socket.send(data),
              sendFast: (data: Uint8Array) => socket.send(data),
              onRecv: (handler: (data: Uint8Array) => void) =>
                socket.addEventListener(
                  'message',
                  (e) => handler(new Uint8Array(e.data)),
                ),
              close: () => socket.close(),
              onClose: (handler: () => void) =>
                socket.addEventListener('close', () => handler()),
            });
          },
        );
      },
    };
  }
}
