import { fs } from '../dev_deps.ts';
import { path } from '../dev_deps.ts';
import { log } from '../deps.ts';
import Context from '../src/Context.ts';
import Config, { makeDefaultConfig } from '../src/Config.ts';
import { bin2hex, hex2bin } from '../src/util/hex.ts';
import BlockService from '../src/BlockService.ts';
import Hash, { ZERO_HASH } from '../src/util/Hash.ts';
import QaDebugger from '../src/QaDebugger.ts';
import { error } from '../src/util/functional.ts';
import LocalGeneratorService, {
  LocalGenerator,
} from '../src/LocalGeneratorService.ts';
// import { epochStartTime } from '~/server/epochStartTime.ts';
import BlockBuilder from '../src/BlockBuilder.ts';
import { accountHash, generatorHash, rootHash } from '../src/constants.ts';
import { AccountContractParams, JsWasiParams } from '../src/messages.ts';
import KeyService from '../src/KeyService.ts';
import GenesisService, { sharedGenesisData } from '../src/GenesisService.ts';
import WorkerExecutor from '../src/WorkerExecutor.ts';
import WebsocketServerProvider from '../plugins/WebsocketServerProvider.ts';
import WebsocketClientProvider from '../plugins/WebsocketClientProvider.ts';
import DenoKvStorageProvider from '../plugins/DenoKvStorageProvider.ts';
import Logger, { FilterAction, LogLevel } from '../src/Logger2.ts';
import NetworkService from '../src/NetworkService.ts';
import { bin2str, str2bin } from '../src/util/buffer.ts';
import RootContract from '../src/contracts/RootContract.ts';
import ConnectionService from '../src/ConnectionService.ts';
import NullStorageProvider from '../plugins/NullStorageProvider.ts';
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

const config: Config = {
  ...makeDefaultConfig(),

  debugName: 'Server',
  // userdata: JSON.stringify({ epochStartTime }),
  // selfPrivateKey: secp.utils.randomPrivateKey(),
  selfPrivateKey: hex2bin(
    '4b84b37d0432660e441bb1c61370264780e28abe74598571b2d5e908ea4a5784',
  ),

  logLevel: log.LogLevels.INFO,

  workerPath: new URL('./worker/worker.ts', import.meta.url).href,

  networkProviders: [
    new WebsocketServerProvider(),
    new WebsocketClientProvider(),
  ],

  // storageProvider: new DenoKvStorageProvider(),
  storageProvider: new NullStorageProvider(),

  initialWorkerCount: 1,
};

for (const provider of config.contractProviders) {
  if (provider instanceof RootContract) {
    const data = str2bin('my secret');
    provider.registry.set(Hash.digest(data).toPrimitive(), data);
  }
}

const ctx = new Context(config);

ctx.get(Logger).registerAttribute('worker', {
  preposition: 'on',
  filterAction: FilterAction.EQ,
});
ctx.get(Logger).registerAttribute('job', {
  prefix: 'job',
  preposition: 'in',
  filterAction: FilterAction.EQ,
});
ctx.get(Logger).registerAttribute('contract', {
  prefix: 'contract',
  preposition: 'for',
  filterAction: FilterAction.EQ,
});
ctx.get(Logger).registerAttribute('params', {
  prefix: 'params',
  preposition: 'for',
  filterAction: FilterAction.EQ,
});
ctx.get(Logger).registerAttribute('body', {
  prefix: 'body',
  preposition: 'forf',
  filterAction: FilterAction.EQ,
});
// INFO Running generation on Worker_1 in job 5e2bcfb7 for contract fa1ff0c1, params a8af5d5b, and body 26bdafde

const arr: string[] = [];
ctx.get(Logger).parseLog(
  arr,
  (key, val) => arr.push(val as string),
  LogLevel.INFO,
  'Running generation',
  {
    worker: 'worker_1',
    job: '5e2bcfb7',
    contract: 'fa1ff0c1',
    params: 'a8af5d5b',
    body: '26bdafde',
  },
);

// throw new Error();

const bootstrapPath = path.join(
  path.dirname(path.fromFileUrl(import.meta.url)),
  'bootstrap',
);
fs.walk(bootstrapPath, { includeDirs: false });

const entries: {
  filename: string;
  contractName: string;
  generator?: string;
  ext: string;
  body: Uint8Array;
  hash: Hash;
}[] = [];
for await (const entry of fs.walk(bootstrapPath, { includeDirs: false })) {
  const body = await Deno.readFile(entry.path);
  const hash = Hash.digest(body);

  const [_, contractName, generator, ext] = entry.name.match(
    /^([\w-]+)\.(?:generator\.([\w-]+)\.)?([\w-]+)$/,
  ) || error(`Invalid filename ${entry.name}!`);

  entries.push({
    filename: entry.name,
    contractName,
    generator,
    ext,
    body,
    hash,
  });
}
entries.forEach(({ filename, contractName, generator, ext, body, hash }) => {
  return;
  if (generator) {
    const contractHash = entries.find((e) =>
      e.contractName === contractName && e.generator === undefined
    )?.hash || error(`No contract with name ${contractName}!`);

    // Supply generator
    switch (ext) {
      case 'js':
        ctx.get(LocalGeneratorService).addGenerator(
          contractHash,
          new Function(bin2str(body))() as LocalGenerator,
        );
        break;

      case 'wasm':
        ctx.get(BlockBuilder).publish({
          body,
          satisfies: [{
            contract_hash: generatorHash,
            params: contractHash.toBytes(),
          }],
        });
        break;
    }
  } else {
    // Supply contract
    ctx.get(BlockBuilder).publish({
      body,
      satisfies: [{
        contract_hash: rootHash,
        params: Hash.digest(body).toBytes(),
      }],
    });
  }

  ctx.get(QaDebugger).addDebugger(filename, hash);
});

(() => {
  // const block = ctx.get(BlockBuilder).buildBlock({});
  // block.inputs.push({ block_hash: Hash.random(), output_idx: 0 });
  // ctx.get(BlockService).create(block);

  // const entry = entries.find((x) => x.filename === 'wasm-custom-section.wasm')!;

  // console.log(bin2hex(JsWasiParams.encode({
  //   argv: [str2bin('wasm-custom-section'), str2bin('help')],
  //   env: [{ key: str2bin('RUST_BACKTRACE'), val: str2bin('1') }],
  //   cwd: [],
  //   files: [],
  //   stdinFrom: [str2bin('identity'), str2bin('')],
  //   stdoutTo: [str2bin('out'), str2bin('stdout')],
  //   stderrTo: [str2bin('out'), str2bin('stderr')],
  // })));

  // ctx.get(ExecutorDriverService).run(
  //   { contract_hash: ZERO_HASH, params: new Uint8Array() },
  //   {},
  //   () => 1,
  //   async (driver, cancel) => {
  //     await driver.setAllocation({});

  //     const { stdout } = await ctx.get(WorkerExecutor).run(
  //       {
  //         code: entry.body,
  //         contractHash: entry.hash.toBytes(),
  //         params: new Uint8Array(),
  //         emitCorrect: true,
  //       },
  //       driver,
  //       cancel,
  //     );

  //     console.log('stdout', new TextDecoder().decode(stdout));
  //   },
  // );

  // const entry = entries.find((x) => x.filename === 'qjs.wasm')!;

  // console.log(bin2hex(JsWasiParams.encode({
  //   argv: [str2bin('quickjs'), str2bin('--module'), str2bin('/in/params')],
  //   env: [{ key: str2bin('RUST_BACKTRACE'), val: str2bin('1') }],
  //   cwd: [],
  //   files: [],
  //   stdinFrom: [str2bin('identity'), str2bin('')],
  //   stdoutTo: [str2bin('out'), str2bin('stdout')],
  //   stderrTo: [str2bin('out'), str2bin('stderr')],
  // })));

  // ctx.get(ExecutorDriverService).run(
  //   { contract_hash: ZERO_HASH, params: new Uint8Array() },
  //   {},
  //   () => 1,
  //   async (driver, cancel) => {
  //     await driver.setAllocation({});

  //     const { stdout } = await ctx.get(WorkerExecutor).run(
  //       {
  //         code: entry.body,
  //         contractHash: entry.hash.toBytes(),
  //         params: str2bin(`
  //           import * as std from 'std';
  //           const f = std.open('/import_map.json', 'w');
  //           f.puts(JSON.stringify({
  //             'https://esm.sh/unique-username-generator@1.2.0?target=esnext&pin=v132': '/ext/bla',
  //           }));
  //           f.close();
  //           const { generateUsername } = import("https://esm.sh/unique-username-generator@1.2.0?target=esnext&pin=v132");

  //         `),
  //         emitCorrect: true,
  //       },
  //       driver,
  //       cancel,
  //     );

  //     console.log('stdout', new TextDecoder().decode(stdout));
  //   },
  // );

  // const entry = entries.find((x) => x.filename === 'assemblyscript.wasm')!;

  // console.log(bin2hex(JsWasiParams.encode({
  //   argv: [
  //     'asc',
  //     '/in/params',
  //     '--outFile',
  //     '/out/bla',
  //     // '--runtime',
  //     // 'stub',
  //     // '--importMemory',
  //     // '--sharedMemory',
  //     // '--maximumMemory',
  //     // '10',
  //   ].map(str2bin),
  //   env: [{ key: str2bin('RUST_BACKTRACE'), val: str2bin('1') }],
  //   cwd: [],
  //   files: [],
  //   stdinFrom: [str2bin('identity'), str2bin('')],
  //   stdoutTo: [str2bin('out'), str2bin('stdout')],
  //   stderrTo: [str2bin('out'), str2bin('stderr')],
  // })));

  // ctx.get(ExecutorDriverService).run(
  //   { contract_hash: ZERO_HASH, params: new Uint8Array() },
  //   {},
  //   () => 1,
  //   async (driver, cancel) => {
  //     await driver.setAllocation({});

  //     const { stdout } = await ctx.get(WorkerExecutor).run(
  //       {
  //         code: entry.body,
  //         contractHash: entry.hash.toBytes(),
  //         params: str2bin(`
  //           export function add(a: i32, b: i32): i32 {
  //             return a + b
  //           }
  //         `),
  //         emitCorrect: true,
  //       },
  //       driver,
  //       cancel,
  //     );

  //     console.log('stdout', new TextDecoder().decode(stdout));
  //   },
  // );

  // const entry = entries.find((x) => x.filename === 'spidermonkey.wasm')!;

  // console.log(bin2hex(JsWasiParams.encode({
  //   argv: [
  //     'spidermonkey',
  //     // '/in/params',
  //     // '--outFile',
  //     // '/out/bla',
  //     // '--runtime',
  //     // 'stub',
  //     // '--importMemory',
  //     // '--sharedMemory',
  //     // '--maximumMemory',
  //     // '10',
  //   ].map(str2bin),
  //   env: [{ key: str2bin('RUST_BACKTRACE'), val: str2bin('1') }],
  //   cwd: [],
  //   files: [],
  //   stdinFrom: [str2bin('in'), str2bin('params')],
  //   stdoutTo: [str2bin('out'), str2bin('stdout')],
  //   stderrTo: [str2bin('out'), str2bin('stderr')],
  // })));

  // ctx.get(ExecutorDriverService).run(
  //   { contract_hash: ZERO_HASH, params: new Uint8Array() },
  //   {},
  //   () => 1,
  //   async (driver, cancel) => {
  //     await driver.setAllocation({});

  //     const { stdout } = await ctx.get(WorkerExecutor).run(
  //       {
  //         code: entry.body,
  //         contractHash: entry.hash.toBytes(),
  //         params: str2bin(`
  //           console.log(1 + 2);
  //         `),
  //         emitCorrect: true,
  //       },
  //       driver,
  //       cancel,
  //     );

  //     console.log('stdout', new TextDecoder().decode(stdout));
  //   },
  // );
})();

// ctx.get(EpochContract).get();

ctx.get(NetworkService).initConnection(
  'websocket@0.0.1',
  undefined,
  (signal) => console.log(`Listening on ${signal}`),
);

// ctx.get(NetworkService).serve((protocol: string, spec: string) =>
//   console.log(
//     `ProtocolProvider ${protocol} is listening with spec ${
//       JSON.stringify(spec)
//     }`,
//   )
// );
// ctx.get(CollatzContract).get();

ctx.get(GenesisService).ingestGenesis(sharedGenesisData);

const itvl = setInterval(() => {
  // const blocks = [...ctx.get(BlockRegistry).debugGetAll().entries()].map((
  //   [hash, val],
  // ) => ({ hash, ...val }));
  // Deno.writeTextFile('./blocks.json', ctx.get(Logger).serialize(blocks));
}, 1000);

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
