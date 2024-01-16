import { http } from '../dev_deps.ts';
import NetworkProvider, { SignalingDriver } from '../src/NetworkProvider.ts';

export default class WebsocketServerProvider implements NetworkProvider {
  public protocols = 'websocket@0.0.1/server';

  public createInstance(driver: SignalingDriver) {
    const port = 8314;

    // Don't await here; I think serve only resolves once the server closes.
    http.serve(
      (req: Request) => {
        if (req.headers.get('upgrade') !== 'websocket') {
          return new Response(null, { status: 501 });
        }
        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.binaryType = 'arraybuffer';

        socket.addEventListener('open', () =>
          driver.createConnection({
            sendReliable: (data: Uint8Array) => socket.send(data),
            sendFast: (data: Uint8Array) => socket.send(data),
            onRecv: (handler: (data: Uint8Array) => void) =>
              socket.addEventListener('message', (e) =>
                handler(new Uint8Array(e.data))),
            shutdown: () =>
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
        .then((body) => body.ip, (err) => {
          console.error(`Could not lookup ip:`, err);
        }),
    ].forEach((host) =>
      Promise.resolve(host).then((host) =>
        host && driver.sendSignal(`ws://${host}:${port}`)
      )
    );

    return {
      recvSignal: () => {
        throw new Error(`A websocket server doesn't receive signals!`);
      },
    };
  }
}
