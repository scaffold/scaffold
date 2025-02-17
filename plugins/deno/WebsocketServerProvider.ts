import { NetworkProvider, SignalingDriver } from '../../src/NetworkProvider.ts';
import { mapPut } from '../../src/util/map.ts';
import { error } from '../../src/util/functional.ts';
import { Hash } from '../../src/util/Hash.ts';

export class WebsocketServerProvider implements NetworkProvider {
  public providesProtocol = 'websocket@0.0.1/server';
  public connectsToProtocols = ['websocket@0.0.1/client'];

  private origins: Promise<string[]>;
  private drivers = new Map<string, SignalingDriver>();

  constructor(port = 8314) {
    const listenResolver = Promise.withResolvers<{ hostname: string; port: number }>();

    Deno.serve({
      port,
      onListen: listenResolver.resolve,
      handler: (req) => {
        if (req.headers.get('upgrade') !== 'websocket') {
          return new Response(null, { status: 501 });
        }

        const url = new URL(req.url);
        const clientToken = url.searchParams.get('clientToken');
        const remoteToken = clientToken ? Hash.fromHex(clientToken) : undefined;

        const signalingDriver = this.drivers.get(url.searchParams.get('serverToken') ?? '');
        if (signalingDriver === undefined) {
          return new Response(null, { status: 401 });
        }

        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.binaryType = 'arraybuffer';

        socket.onopen = () => {
          const connDriver = signalingDriver.createConnection(remoteToken, {
            sendReliable: (data: Uint8Array) => socket.send(data),
            sendFast: (data: Uint8Array) => socket.send(data),
            shutdown: () => socket.close(),
          });

          socket.onmessage = (e) => connDriver.recvData(new Uint8Array(e.data));
          socket.onclose = () => connDriver.close();

          // socket.onerror = (e) => console.error(e);
        };

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
    ]).then((x) => x.filter((val, idx, arr) => val && arr.indexOf(val) === idx));
  }

  public createInstance(driver: SignalingDriver) {
    const serverToken = driver.myToken?.toHex() ?? '';

    mapPut(
      this.drivers,
      serverToken,
      () => driver,
      () => error(`Cannot replace driver for token ${serverToken}!`),
    );

    this.origins.then((origins) => {
      for (const origin of origins) {
        driver.sendSignal(serverToken ? `${origin}/?serverToken=${serverToken}` : origin);
      }
    });

    return {
      recvSignal: () => {
        throw new Error(`A websocket server doesn't receive signals!`);
      },
    };
  }
}
