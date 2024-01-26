import { NetworkProvider, SignalingDriver } from '../src/NetworkProvider.ts';

export class WebsocketClientProvider implements NetworkProvider {
  public protocols = 'websocket@0.0.1/client';

  public createInstance(driver: SignalingDriver) {
    const sockets: WebSocket[] = [];

    return {
      recvSignal: (signal: string) => {
        const socket = new WebSocket(signal);
        socket.binaryType = 'arraybuffer';
        sockets.push(socket);
        socket.addEventListener(
          'open',
          () => {
            // Close any other attempted sockets
            sockets.forEach((s) => s !== socket && s.close());

            driver.createConnection({
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
