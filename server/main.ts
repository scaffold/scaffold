import * as fs from 'std-latest/fs/mod.ts';
import * as path from 'std-latest/path/mod.ts';
import secp from '~/sbl/util/secp.ts';
import Context from '~/sbl/Context.ts';
import Config from '~/sbl/Config.ts';
import { serve } from 'std-fix-abortable/http/mod.ts';
import {
  ConnectionProvider,
  ProtocolProvider,
} from '../sbl/NetworkProvider.ts';
import Peer from '~/sbl/Peer.ts';
import ServingService from '~/sbl/ServingService.ts';
import { bin2hex, hex2bin } from '~/sbl/util/hex.ts';
import Logger from '~/sbl/Logger.ts';
import BlockService from '../sbl/BlockService.ts';
import Hash from '~/sbl/util/Hash.ts';
import { BlockRegistry } from '../sbl/registries.ts';
import CollatzContract from '../graph/CollatzContract.ts';
import QaDebugger from '../sbl/QaDebugger.ts';
import GraphUtils from '../sbl/GraphUtils.ts';
// import EpochContract from '~/graph/EpochContract.ts';
// import ThrustInitContract from '~/graph/ThrustInitContract.ts';
// import ThrustGameContract from '~/graph/ThrustGameContract.ts';
// import StateTracker from '~/sbl/StateTracker.ts';
// import * as thrustMessages from '~/graph/thrustMessages.ts';
// import QuestionService from '~/sbl/QuestionService.ts';
// import * as epochMessages from '~/graph/epochMessages.ts';
// // import DefaultAppraisalProvider from '~/sbl/DefaultAppraisalProvider.ts';
// import { unzip } from './tools.ts';
// import GraphUtils from '~/sbl/GraphUtils.ts';
// import { formatPath, parsePath } from '~/sbl/pathUtils.ts';
// import { Generator } from '~/sbl/scriptTypes.ts';
// import AnyContract from '~/graph/AnyContract.ts';
// import { arrEquals } from '~/sbl/util/buffer.ts';

const websocketProvider: ProtocolProvider = {
  createServer: (
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

  createClient: (
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ) => {
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
  },
};

const config: Config = {
  debugName: 'Server',

  log: {
    handler: (
      ctx: Context,
      className: string,
      methodName: string,
      params: Record<string, any>,
    ) =>
      console.log(
        `${className}.${methodName}(${ctx.get(Logger).serialize(params)})`,
      ),
  },

  location: { x: 1, y: 2, z: 3 },

  shouldVerify: (ctx: Context, fromPeer: Peer, pub: any) => true,

  networkProvider: {
    protocols: new Map(Object.entries({
      websocket: websocketProvider,
    })),
  },

  // appraisalProvider: new DefaultAppraisalProvider(),

  trustedPeers: [],

  // selfPrivateKey: secp.utils.randomPrivateKey(),
  selfPrivateKey: hex2bin(
    '4b84b37d0432660e441bb1c61370264780e28abe74598571b2d5e908ea4a5784',
  ),
  nodeNonce: (new TextEncoder()).encode('server_0'),

  approxComputePricePerSecond: 1000n,

  initialWorkerCount: 1,

  onlyBridge: true,

  computeContracts: [],
};

const ctx = new Context(config);

const bootstrapPath = path.join(
  path.dirname(path.fromFileUrl(import.meta.url)),
  'bootstrap',
);
for await (const entry of fs.walk(bootstrapPath, { includeDirs: false })) {
  const body = await Deno.readFile(entry.path);
  ctx.get(GraphUtils).supplyRawAnswer(body);
  ctx.get(QaDebugger).addDebugger(entry.name, Hash.digest(body));
}

// ctx.get(EpochContract).get();
ctx.get(ServingService).serve((protocol: string, spec: string) =>
  console.log(
    `ProtocolProvider ${protocol} is listening with spec ${
      JSON.stringify(spec)
    }`,
  )
);
// ctx.get(CollatzContract).get();

const itvl = setInterval(() => {
  // const blocks = [...ctx.get(BlockRegistry).debugGetAll().entries()].map((
  //   [hash, val],
  // ) => ({ hash, ...val }));
  // Deno.writeTextFile('./blocks.json', ctx.get(Logger).serialize(blocks));
}, 1000);

// ctx.get(WorkLoop);

self.addEventListener('unload', () => {
  clearInterval(itvl);
  ctx.destruct();
});

// // Let's start listening to the epoch.
// // We won't need this eventually because everyone will be requesting it.
// (() => {
//   const contractHash = ctx.get(EpochContract).get().hash;

//   const tracker = ctx.get(StateTracker).track(
//     (idx) => ({
//       contract_hash: contractHash,
//       params: epochMessages.Params.encode({ height: idx }),
//     }),
//     (idx, state) =>
//       console.log(`Epoch ${idx}: ${Hash.digest(state.data).toHex()}`),
//     {
//       initIdx: 0n,
//       futureSubCount: 100n,
//       narrowingSubCount: 16n,
//       unsubWaitMs: 10000,
//     },
//   );

//   ctx.onDestruct(() => tracker.release());
// })();

// // Start a game, and print the hash.
// // Other clients won't know the nonce or init_time, so will have to request it from this client.
// const gameHash = ctx.get(ThrustInitContract).startGame(Hash.random());
// setTimeout(
//   () =>
//     console.log(
//       `http://localhost:4507/public/index.html?game=${gameHash.toHex()}`,
//     ),
//   200,
// );

// const runWasm = false;
// runWasm && (async () => {
//   const str2bin = (str: string) => new TextEncoder().encode(str);

//   console.log('Fetching zip file...');

//   const zip = await fetch(
//     // `https://github.com/wapm-packages/clang/archive/refs/heads/master.zip`,
//     `file:///Users/joel/Downloads/clang-master.zip`,
//   ).then((resp) => resp.arrayBuffer()).then((buf) => new Uint8Array(buf));

//   console.log('Unzipping...');

//   const cmds = unzip(zip, (key, contents) => {
//     key.unshift(str2bin('scratch'));

//     if (key[key.length - 1].length === 0) {
//       // Directory
//       return { mkdir: { at: key.slice(0, -1) } };
//     } else {
//       // File
//       const hash =
//         ctx.get(GraphUtils).supplyRawAnswer(contents).question.spec.params;
//       return {
//         link: {
//           from: [str2bin('ext'), hash],
//           to: key,
//         },
//       };
//     }
//   });

//   console.log('Providing chunks...');

//   console.log(
//     cmds
//       .filter(
//         (cmd) => cmd.link && formatPath(cmd.link.to) === '/scratch/clang.wasm',
//       )
//       .map(
//         (cmd) =>
//           cmd.link &&
//           `${formatPath(cmd.link.from)} -> ${formatPath(cmd.link.to)}`,
//       ),
//   );
//   // /ext/:f310e582869203573dbbb7a06d8d5e8f9b457261f3b488bf2a37de85d227450ab -> /scratch/clang.wasm

//   console.log('Submitting...');

//   const clangGenerator: Generator = {
//     cmds: [
//       ...cmds,
//       {
//         wasm: {
//           execPath: parsePath('/scratch/clang.wasm'),
//           args: [
//             'clang',
//             '-cc1',
//             '-triple',
//             'wasm32-unknown-wasi',
//             '-isysroot',
//             '/sys',
//             '-internal-isystem',
//             '/sys/include',
//             '-emit-obj',
//             '-o',
//             './example.o',
//             '-',
//           ],
//           env: {},
//           cwd: parsePath('/scratch'),
//           // root: parsePath('/'),
//           stdinFrom: [
//             str2bin('identity'),
//             str2bin(
//               'int printf(const char *, ...); int main(){printf("hello world!\n");}',
//             ),
//           ],
//           stdoutTo: parsePath('/out/debug1'),
//           stderrTo: parsePath('/out/debug2'),
//         },
//       },
//       {
//         wasm: {
//           execPath: parsePath('/scratch/wasm-ld.wasm'),
//           args: [
//             'wasm-ld',
//             '-L/sys/lib/wasm32-wasi',
//             '/sys/lib/wasm32-wasi/crt1.o',
//             './example.o',
//             '-lc',
//             '-o',
//             './example.wasm',
//           ],
//           env: {},
//           cwd: parsePath('/'),
//           // root: parsePath('/'),
//           stdinFrom: [
//             str2bin('identity'),
//             str2bin(
//               'int printf(const char *, ...); int main(){printf("hello world!\n");}',
//             ),
//           ],
//           stdoutTo: parsePath('/out/debug3'),
//           stderrTo: parsePath('/out/debug4'),
//         },
//       },
//       {
//         link: {
//           from: parsePath('/example.wasm'),
//           to: parsePath('/out/output'),
//         },
//       },
//     ],
//     runtime: 0,
//     exposeEvent: false,
//     exposeSecret: false,
//   };

//   const clangContract = (
//     contractHash: Hash,
//     params: Uint8Array,
//     hint: Uint8Array,
//     request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
//   ) => {
//     const name = 'clangContract';
//     return true;
//   };

//   const contract = ctx.get(GraphUtils).supplyContract(clangContract);
//   ctx.get(GraphUtils).supplyGenerator(contract, clangGenerator);

//   const question = ctx.get(QuestionService).getCanonical({
//     contract_hash: contract.hash,
//     params: new Uint8Array([]),
//   });
//   question.onAnswer((answer) => console.log(answer));
//   question.incentivize(1000000n);
// })().catch((err) => console.error(err));

// https://wapm.io/mozilla/spidermonkey
// https://github.com/golemfactory/sp-wasm
// https://github.com/bytecodealliance/wasmtime/blob/main/cranelift/spidermonkey.md
