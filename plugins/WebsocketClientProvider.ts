import { NetworkProvider, SignalingDriver } from '../legacy2/NetworkProvider.ts';
import { Hash } from '../src/util/Hash.ts';

export class WebsocketClientProvider implements NetworkProvider {
  public providesProtocol = 'websocket@0.0.1/client';
  public connectsToProtocols = ['websocket@0.0.1/server'];

  public createInstance(signalingDriver: SignalingDriver) {
    const sockets: WebSocket[] = [];
    let isOpen = false;

    return {
      recvSignal: (signal: string) => {
        if (isOpen) {
          return;
        }

        const url = new URL(signal);
        const serverToken = url.searchParams.get('serverToken');
        const remoteToken = serverToken ? Hash.fromHex(serverToken) : undefined;

        if (signalingDriver.myToken !== undefined) {
          url.searchParams.set('clientToken', signalingDriver.myToken.toHex());
        }

        const socket = new WebSocket(url.toString());
        socket.binaryType = 'arraybuffer';

        socket.onopen = () => {
          if (isOpen) {
            return;
          }

          // Close any other attempted sockets
          sockets.forEach((s) => s !== socket && s.close());
          isOpen = true;

          const connDriver = signalingDriver.createConnection(remoteToken, {
            sendReliable: (data: Uint8Array) => socket.send(data),
            sendFast: (data: Uint8Array) => socket.send(data),
            shutdown: () => socket.close(),
          });

          socket.onmessage = (e) => connDriver.recvData(new Uint8Array(e.data));
          socket.onclose = () => connDriver.close();
        };

        sockets.push(socket);
      },
    };
  }
}
