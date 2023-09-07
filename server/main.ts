import * as fs from 'std-latest/fs/mod.ts';
import * as path from 'std-latest/path/mod.ts';
import Context from '~/sbl/Context.ts';
import Config, { defaultConfig } from '~/sbl/Config.ts';
import ServingService from '~/sbl/ServingService.ts';
import { bin2hex, hex2bin } from '~/sbl/util/hex.ts';
import BlockService from '../sbl/BlockService.ts';
import Hash, { ZERO_HASH } from '~/sbl/util/Hash.ts';
import QaDebugger from '../sbl/QaDebugger.ts';
import { error } from '../sbl/util/functional.ts';
import { bin2str, str2bin } from '../sbl/pathUtils.ts';
import LocalGeneratorService, {
  LocalGenerator,
} from '../sbl/LocalGeneratorService.ts';
import { epochStartTime } from '~/server/epochStartTime.ts';
import BlockBuilder from '~/sbl/BlockBuilder.ts';
import { accountHash, generatorHash, rootHash } from '~/sbl/constants.ts';
import { AccountContractParams, JsWasiParams } from '~/sbl/messages.ts';
import KeyService from '~/sbl/KeyService.ts';
import GenesisService from '~/sbl/GenesisService.ts';
import * as log from 'std-latest/log/mod.ts';
import ExecutorDriverService from '~/sbl/ExecutorDriverService.ts';
import WorkerExecutor from '~/sbl/WorkerExecutor.ts';
import websocketServerProvider from '~/plugins/websocketServerProvider.ts';
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
  ...defaultConfig,

  debugName: 'Server',
  userdata: JSON.stringify({ epochStartTime }),
  // selfPrivateKey: secp.utils.randomPrivateKey(),
  selfPrivateKey: hex2bin(
    '4b84b37d0432660e441bb1c61370264780e28abe74598571b2d5e908ea4a5784',
  ),

  logLevel: log.LogLevels.INFO,

  networkProvider: {
    protocols: new Map(Object.entries({
      websocket: websocketServerProvider(),
    })),
  },

  initialWorkerCount: 1,
  onlyBridge: false,
};

const ctx = new Context(config);

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
        ctx.get(BlockService).create(
          ctx.get(BlockBuilder).emit({ body }, [{
            contract_hash: generatorHash,
            params: contractHash.toBytes(),
          }]),
        );
        break;
    }
  } else {
    // Supply contract
    ctx.get(BlockService).create(
      ctx.get(BlockBuilder).emit({ body }, [{
        contract_hash: rootHash,
        params: Hash.digest(body).toBytes(),
      }]),
    );
  }

  ctx.get(QaDebugger).addDebugger(filename, hash);
});

(() => {
  ctx.get(BlockService).create({
    inputs: [{ block_hash: Hash.random(), output_idx: 0 }],
    outputs: [{
      amount: 100000000n,
      verifier: {
        contract_hash: accountHash,
        params: AccountContractParams.encode({
          public_key: ctx.get(KeyService).getSelfPublicKey(),
        }),
      },
    }],
    frontier_vote: ZERO_HASH,
    body: new Uint8Array(),
    is_free_market: true,
    timestamp: BigInt(ctx.config.timeProvider.now()),
  });

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
  //   argv: [str2bin('quickjs'), str2bin('--help')],
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
})();

// ctx.get(EpochContract).get();
ctx.get(ServingService).serve((protocol: string, spec: string) =>
  console.log(
    `ProtocolProvider ${protocol} is listening with spec ${
      JSON.stringify(spec)
    }`,
  )
);
// ctx.get(CollatzContract).get();

ctx.get(GenesisService);

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
