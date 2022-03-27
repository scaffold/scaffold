import secp from '~/sbl/util/secp.ts';
import Context from '~/sbl/Context.ts';
import Config from '~/sbl/Config.ts';
import { serve } from 'https://deno.land/std/http/mod.ts';
import {
  ConnectionProvider,
  ProtocolProvider,
} from '../sbl/NetworkProvider.ts';
import Peer from '~/sbl/Peer.ts';
import ServingService from '~/sbl/ServingService.ts';
import SampleContracts from '~/graph/SampleContracts.ts';
import EpochContract from '~/graph/EpochContract.ts';

const websocketProvider: ProtocolProvider = {
  create: (
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ) => {
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
              close: () => socket.close(),
              onClose: (handler: () => void) =>
                socket.addEventListener('close', () => handler()),
            });
          },
        );
      },
    };
  },

  serve: (
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ) => {
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
  },
};

const config: Config = {
  location: { x: 1, y: 2, z: 3 },

  shouldVerify: (ctx: Context, fromPeer: Peer, pub: any) => true,

  contracts: [],

  generators: [],

  networkProvider: {
    protocols: new Map(Object.entries({ websocket: websocketProvider })),
  },

  trustedPeers: [],

  selfPrivateKey: secp.utils.randomPrivateKey(),
  nodeNonce: (new TextEncoder()).encode('server_0'),
};

const ctx = new Context(config);
ctx.get(SampleContracts).apply({});
ctx.get(EpochContract).apply();
ctx.get(ServingService);
