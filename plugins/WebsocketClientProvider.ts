import { NetworkProvider, SignalingDriver } from '../src/NetworkProvider.ts';

export class WebsocketClientProvider implements NetworkProvider {
  public providesProtocols = ['websocket@0.0.1/client'];
  public connectsToProtocols = ['websocket@0.0.1/server'];

  public createInstance(driver: SignalingDriver) {
    const sockets: WebSocket[] = [];
    let isOpen = false;

    return {
      recvSignal: (signal: string) => {
        if (isOpen) {
          return;
        }

        const socket = new WebSocket(signal);
        socket.binaryType = 'arraybuffer';
        sockets.push(socket);
        socket.addEventListener('open', () => {
          if (isOpen) {
            return;
          }

          // Close any other attempted sockets
          sockets.forEach((s) => s !== socket && s.close());
          isOpen = true;

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
        });
      },
    };
  }
}
