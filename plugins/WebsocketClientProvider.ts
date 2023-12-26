import NetworkProvider, {
  ConnectionProvider,
  ListeningMode,
} from '~/sbl/NetworkProvider.ts';

export default class WebsocketClientProvider implements NetworkProvider {
  public protocolName = 'websocket';
  public listeningMode = ListeningMode.Unique;

  public createClient(
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ) {
    const sockets: WebSocket[] = [];

    return {
      tryConnect: (spec: string) => {
        const socket = new WebSocket(spec);
        socket.binaryType = 'arraybuffer';
        sockets.push(socket);
        socket.addEventListener(
          'open',
          () => {
            // Close any other attempted sockets
            sockets.forEach((s) => s !== socket && s.close());

            onNewConn({
              sendReliable: (data: Uint8Array) => socket.send(data),
              sendFast: (data: Uint8Array) => socket.send(data),
              onRecv: (handler: (data: Uint8Array) => void) =>
                socket.addEventListener(
                  'message',
                  (e) => handler(new Uint8Array(e.data)),
                ),
              shutdown: () => socket.close(),
              onClose: (handler: () => void) =>
                socket.addEventListener('close', () => handler()),
            });
          },
        );
      },
    };
  }
}
