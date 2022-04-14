import secp from '~/sbl/util/secp.ts';
import Context from '~/sbl/Context.ts';
import Config from '~/sbl/Config.ts';
import { serve } from 'std-fix-abortable/http/mod.ts';
import {
  ConnectionProvider,
  ProtocolProvider,
} from '../sbl/NetworkProvider.ts';
import Peer from '~/sbl/Peer.ts';
import Hash from '~/sbl/util/Hash.ts';
import ServingService from '~/sbl/ServingService.ts';
import EpochContract from '~/graph/EpochContract.ts';
import ThrustInitContract from '~/graph/ThrustInitContract.ts';
import ThrustGameContract from '~/graph/ThrustGameContract.ts';
import StateTracker from '~/sbl/StateTracker.ts';
import * as thrustMessages from '~/graph/thrustMessages.ts';
import Logger from '~/sbl/Logger.ts';
import QuestionService from '~/sbl/QuestionService.ts';

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
  log: {
    handler: (
      ctx: Context,
      className: string,
      methodName: string,
      params: Record<string, any>,
    ) =>
      console.log(
        `${className}.${methodName}(${
          JSON.stringify(params, (key, val) => Logger.serialize(val), 0)
        })`,
      ),
  },

  location: { x: 1, y: 2, z: 3 },

  shouldVerify: (ctx: Context, fromPeer: Peer, pub: any) => true,

  networkProvider: {
    protocols: new Map(Object.entries({ websocket: websocketProvider })),
  },

  trustedPeers: [],

  selfPrivateKey: secp.utils.randomPrivateKey(),
  nodeNonce: (new TextEncoder()).encode('server_0'),

  approxComputePricePerSecond: 1000n,

  initialWorkerCount: 1,
};

const ctx = new Context(config);
// ctx.get(EpochContract).get();
ctx.get(ServingService).serve((protocol: string, spec: string) =>
  console.log(
    `ProtocolProvider ${protocol} is listening with spec ${
      JSON.stringify(spec)
    }`,
  )
);

(() => {
  const match = ctx.get(ThrustInitContract).startGame(Hash.digest('abc'));

  const contractHash = ctx.get(ThrustGameContract).get().hash;

  // const tick = 10n;
  // ctx.get(QuestionService).getCanonical({
  //   contract_answer_hash: contractHash,
  //   params: thrustMessages.GameParams.encode({ match, tick }),
  // }, (answer) =>
  //   console.log({
  //     tick,
  //     gameState: thrustMessages.GameAnswer.decode(answer.data),
  //   }));

  const tracker = ctx.get(StateTracker).track(
    (idx) => ({
      contract_answer_hash: contractHash,
      params: thrustMessages.GameParams.encode({
        match,
        tick: idx,
      }),
    }),
    (idx, state) =>
      console.log({
        tick: idx,
        gameState: thrustMessages.GameAnswer.decode(state.data),
      }),
    {
      initIdx: 0n,
      futureSubCount: 100n,
      narrowingSubCount: 16n,
      unsubWaitMs: 10000,
    },
  );

  return () => tracker.release();
})();

self.addEventListener('unload', () => ctx.destruct());
