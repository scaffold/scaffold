import { NetworkProvider, SignalingDriver } from '../src/NetworkProvider.ts';
import { mapPut } from '../src/util/map.ts';
import { error } from '../src/util/functional.ts';
import { Hash } from '../src/util/Hash.ts';

export class WebsocketServerProvider implements NetworkProvider {
  public providesProtocols = ['websocket@0.0.1/server'];
  public connectsToProtocols = ['websocket@0.0.1/client'];

  private origins: Promise<string[]>;
  private drivers = new Map<string, SignalingDriver>();

  constructor(port = 8314) {
    const listenResolver = Promise.withResolvers<
      { hostname: string; port: number }
    >();
    Deno.serve({
      port,
      onListen: listenResolver.resolve,
      handler: (req) => {
        if (req.headers.get('upgrade') !== 'websocket') {
          return new Response(null, { status: 501 });
        }

        const token = new URL(req.url).searchParams.get('token');
        const driver = this.drivers.get(token || '');
        if (driver === undefined) {
          return new Response(null, { status: 401 });
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
        // socket.addEventListener('error', (e) => console.error(e));

        return response;
      },
    });

    this.origins = Promise.all([
      listenResolver.promise.then((x) => `ws://${x.hostname}:${x.port}`),
      `ws://127.0.0.1:${port}`,
      fetch('https://api.ipify.org/?format=json').then((resp) => resp.json())
        .then(
          (body) => body.ip ? `ws://${body.ip}:${port}` : '',
          (err) => {
            console.error(`Could not lookup ip:`, err);
            return '';
          },
        ),
    ]).then((x) =>
      x.filter((val, idx, arr) => val && arr.indexOf(val) === idx)
    );
  }

  public createInstance(driver: SignalingDriver) {
    const token = driver.useToken ? Hash.random().toHex() : '';

    mapPut(
      this.drivers,
      token,
      () => driver,
      () => error(`Cannot replace driver for token ${token}!`),
    );

    this.origins.then((origins) => {
      for (const origin of origins) {
        driver.sendSignal(token ? `${origin}/?token=${token}` : origin);
      }
    });

    return {
      recvSignal: () => {
        throw new Error(`A websocket server doesn't receive signals!`);
      },
    };
  }
}
