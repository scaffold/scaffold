import { bin2hex, bin2str, formatPath, str2bin } from '../pathUtils.ts';
import { LinkExec, MkdirExec, WasmExec } from '../scriptTypes.ts';
import ExtFs from './ExtFs.ts';
import {
  FS_CAPABILITY_ALL,
  FS_CAPABILITY_DIR_ENTRY_CREATE,
  FS_CAPABILITY_DIR_ENTRY_REMOVE,
  FS_CAPABILITY_DIR_LIST_ENTRIES,
  FS_CAPABILITY_DIR_READ_ENTRY,
  FS_CAPABILITY_FILE_READ,
  FS_CAPABILITY_FILE_WRITE,
  FsDirNode,
  FsFileNode,
  FsNode,
} from './fsTypes.ts';
import IdentityFs from './IdentityFs.ts';
import MemFs from './MemFs.ts';
import WasiImpl, { FsNodeHandle } from './WasiImpl.ts';
import { WorkerChannelClient } from './WorkerChannel.ts';
import { JobMessage, WorkerComm } from './workerTypes.ts';
import * as log from 'https://deno.land/std@0.173.0/log/mod.ts';

// const logger: Logger = {
//   info: (data, msg) => console.log(data, msg),
//   warn: (data, msg) => console.warn(data, msg),
//   error: (data, msg) => console.error(data, msg),
// };
const formatter: log.FormatterFunction = (logRecord) =>
  `${logRecord.levelName} ${logRecord.msg} ${
    logRecord.args.map((a) =>
      JSON.stringify(a, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value)
    ).join(',')
  }`;

const consoleHandler = new log.handlers.ConsoleHandler('DEBUG', { formatter });
const fileHandler = new log.handlers.FileHandler('DEBUG', {
  filename: `/tmp/sbl_worker_${Date.now()}_${
    Math.random().toString(36).slice(2)
  }.log`,
  formatter,
});
log.setup({
  handlers: { console: consoleHandler, file: fileHandler },

  loggers: {
    worker: {
      level: 'DEBUG',
      handlers: ['console', 'file'],
    },
  },
});
const logger = log.getLogger('worker');
setInterval(() => fileHandler.flush(), 1000);

const throwErr = (msg: string): never => {
  throw new Error(msg);
};

export default async (
  client: WorkerChannelClient<WorkerComm>,
  { codeVerifier, inputs, outputSpec }: JobMessage,
) => {
  const inodeSource = { nextInode: 1 };

  const memFs = new MemFs(inodeSource);
  const fsRoot = memFs.createDirNode();

  const extFs = new ExtFs(inodeSource, client);
  const extRoot = fsRoot.mutEntry(
    str2bin('ext'),
    (entry) =>
      entry ? throwErr(`/ext already exists`) : {
        val: extFs.createDirNode(),
        capMask: FS_CAPABILITY_DIR_READ_ENTRY | FS_CAPABILITY_FILE_READ,
      },
  );
  client.inform('init', ['ext', extRoot.getInode()], []);

  const identityFs = new IdentityFs(inodeSource);
  const identityRoot = fsRoot.mutEntry(
    str2bin('identity'),
    (entry) =>
      entry ? throwErr(`/identity already exists`) : {
        val: identityFs.createDirNode(),
        capMask: FS_CAPABILITY_DIR_READ_ENTRY | FS_CAPABILITY_FILE_READ,
      },
  );

  const lookupPath = (path: Uint8Array[]) =>
    path.reduce<FsNode>(
      (node, key) =>
        node
          .dispatch(
            { dir: (dir: FsDirNode) => dir },
            () => throwErr(`Not a dir`),
          )
          .mutEntry(
            key,
            (entry) => entry || throwErr(`Entry ${bin2str(key)} not found`),
          ),
      fsRoot,
    );

  const execMkdir = ({ at }: MkdirExec) => {
    const atKey = at.pop();
    if (!atKey) {
      throwErr(`Must provide a non-root "at" path`);
    }

    lookupPath(at)
      .dispatch({ dir: (dir: FsDirNode) => dir }, () => throwErr(`Not a dir`))
      .mutEntry(
        atKey!,
        (node) =>
          node
            ? throwErr(`Entry ${bin2str(atKey!)} already exists`)
            : { val: memFs.createDirNode(), capMask: FS_CAPABILITY_ALL },
      );
  };

  const execLink = ({ from, to }: LinkExec) => {
    const toKey = to.pop();
    if (!toKey) {
      throwErr(`Must provide a non-root "to" path`);
    }

    const fromNode = lookupPath(from);
    const toNode = lookupPath(to);
    toNode
      .dispatch({ dir: (dir: FsDirNode) => dir }, () => throwErr(`Not a dir`))
      .mutEntry(
        toKey!,
        (node) =>
          node
            ? throwErr(`Entry ${bin2str(toKey!)} already exists`)
            : { val: fromNode, capMask: FS_CAPABILITY_ALL },
      );
  };

  const execWasm = async (spec: WasmExec) => {
    // Note that if the WASM module exports its own memory, this won't be used
    const memory = new WebAssembly.Memory({
      // initial: 10, // Each page is 64KiB
      initial: 1 << 12, // Each page is 64KiB
      maximum: 1 << 12, // Each page is 64KiB
      shared: true,
    });

    const wasi = new WasiImpl(
      memory,
      spec.args.map((arg) => str2bin(arg)),
      Object.entries(spec.env).map(([key, val]) => ({
        key: str2bin(key),
        val: str2bin(val),
      })),
      spec.cwd,
      logger,
    );

    const rootHandle = wasi.makeHandle(fsRoot, FS_CAPABILITY_ALL);
    const lookupPath = (path: Uint8Array[], create: boolean): FsNodeHandle => {
      return path.reduce(
        (handle, key, idx, path) =>
          handle.dirMutEntry(
            key,
            (node) =>
              node ||
              (create
                ? idx === path.length - 1
                  ? handle.node.getFs().createFileNode()
                  : handle.node.getFs().createDirNode()
                : throwErr(`Path ${formatPath(path)} does not exist`)),
          ),
        rootHandle,
      );
    };

    const execNode = lookupPath(spec.execPath, false);
    wasi.resetFds(
      lookupPath(spec.stdinFrom, false),
      lookupPath(spec.stdoutTo, true),
      lookupPath(spec.stderrTo, true),
      [[]].map((path) => ({ path, handle: lookupPath(path, true) })),
    );

    const CHUNK_SIZE = 65536;
    const sourceArr = [];
    let size = 0;
    while (true) {
      const c = new Uint8Array(new SharedArrayBuffer(CHUNK_SIZE));
      const read = execNode.fileRead(size, [c]);
      sourceArr.push(c.subarray(0, read));
      size += read;
      if (read !== CHUNK_SIZE) {
        break;
      }
    }

    const source = new Uint8Array(size);
    sourceArr.forEach((s, i) => source.set(s, i * CHUNK_SIZE));

    const imports = wasi.getImports();

    const { module, instance } = await WebAssembly.instantiate(source, {
      env: {
        memory,
        openatBinary: (fd: number, entry: number, ...rest: any[]) => {
          logger.info({ fd, entry, rest }, 'openatBinary');
          return -1;
        },
      },
      wasi_snapshot_preview1: imports,
      wasi_unstable: imports,
    } as any);

    logger.error(instance.exports, 'EXPORTS');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    return wasi.run(instance);
  };

  const inDir = fsRoot.mutEntry(
    str2bin('in'),
    (entry) =>
      entry ? throwErr(`/in already exists`) : {
        val: memFs.createDirNode(),
        capMask: FS_CAPABILITY_DIR_LIST_ENTRIES |
          FS_CAPABILITY_DIR_READ_ENTRY |
          FS_CAPABILITY_FILE_READ,
      },
  );
  const outDir = fsRoot.mutEntry(
    str2bin('out'),
    (entry) =>
      entry ? throwErr(`/out already exists`) : {
        val: memFs.createDirNode(),
        capMask: FS_CAPABILITY_DIR_LIST_ENTRIES |
          FS_CAPABILITY_DIR_READ_ENTRY |
          FS_CAPABILITY_DIR_ENTRY_CREATE |
          FS_CAPABILITY_DIR_ENTRY_REMOVE |
          FS_CAPABILITY_FILE_READ |
          FS_CAPABILITY_FILE_WRITE,
      },
  );

  Object.entries(inputs).forEach(([key, data]) => {
    const file = inDir.mutEntry(
      str2bin(key),
      (entry) =>
        entry ? throwErr(`/in/${key} already exists`) : {
          val: memFs.createFileNode(),
          capMask: FS_CAPABILITY_FILE_READ,
        },
    );
    file.write(0, [data]);
  });

  // await script.cmds.reduce(
  //   async (
  //     wait: Promise<void>,
  //     {
  //       mkdir,
  //       link,
  //       wasm,
  //     }: { mkdir?: MkdirExec; link?: LinkExec; wasm?: WasmExec },
  //   ) => {
  //     const count = [mkdir, link, wasm].filter(Boolean).length;
  //     if (count !== 1) {
  //       throwErr(
  //         `Must specify exactly one ExecSpec for each command, actually specified ${count}`,
  //       );
  //     }

  //     await wait;

  //     mkdir && (await execMkdir(mkdir));
  //     link && (await execLink(link));
  //     wasm && (await execWasm(wasm));
  //   },
  //   Promise.resolve(),
  // );

  const args = [
    ...bin2str(inputs.params).matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g),
  ].map((m) => m[1] || m[2] || m[3]);
  logger.info('ARGS', args);

  await execWasm({
    execPath: [
      str2bin('ext'),
      codeVerifier.contractHash,
      codeVerifier.params,
    ],
    args,
    // args: [
    //   bin2hex(codeVerifier.contractHash) + '_' + bin2hex(codeVerifier.params),
    //   '--eval',
    //   'console.log(123*7)',
    // ],
    env: {},

    cwd: [],

    stdinFrom: [str2bin('in'), str2bin('stdin')],
    stdoutTo: [str2bin('out'), str2bin('stdout')],
    stderrTo: [str2bin('out'), str2bin('stderr')],
  });

  Object.entries(outputSpec).forEach(([key, _]) => {
    const file = outDir
      .mutEntry(str2bin(key), (entry) => entry)
      ?.dispatch(
        { file: (file: FsFileNode) => file },
        () => throwErr(`/out/${key} is not a file`),
      ) || memFs.createFileNode();

    const CHUNK_SIZE = 65536;
    let offset = 0;
    while (true) {
      const chunk = new Uint8Array(CHUNK_SIZE);
      const read = file.read(offset, [chunk]);
      if (read !== CHUNK_SIZE) {
        client.inform(
          'outputChunk',
          [key, offset, chunk.subarray(0, read)],
          [chunk.buffer],
        );
        break;
      } else {
        client.inform('outputChunk', [key, offset, chunk], [chunk.buffer]);
        offset += CHUNK_SIZE;
      }
    }
  });
};
