import { LinkExec, MkdirExec } from '../scriptTypes.ts';
import { error } from '../util/functional.ts';
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
import { JsWasiParams } from '../messages.ts';
import logger from './logger.ts';
import { BaseImports } from './execJob.ts';
import { makeClientUtils } from './clientUtils.ts';
import { bin2str, str2bin } from '../util/buffer.ts';
import { formatPath } from './pathUtils.ts';

export const makeWasi = (
  client: WorkerChannelClient<WorkerComm>,
  wasiParams: JsWasiParams,
  job: JobMessage,
  baseImports: BaseImports,
) => {
  const inodeSource = { nextInode: 1 };

  const memFs = new MemFs(inodeSource);
  const fsRoot = memFs.createDirNode();

  const extFs = new ExtFs(inodeSource, client);
  const extRoot = fsRoot.mutEntry(
    str2bin('ext'),
    (entry) =>
      entry ? error(`/ext already exists`) : {
        val: extFs.createDirNode(),
        capMask: FS_CAPABILITY_DIR_READ_ENTRY | FS_CAPABILITY_FILE_READ,
      },
  );
  client.inform('init', ['ext', extRoot.getInode()], []);

  const identityFs = new IdentityFs(inodeSource);
  const identityRoot = fsRoot.mutEntry(
    str2bin('identity'),
    (entry) =>
      entry ? error(`/identity already exists`) : {
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
            () => error(`Not a dir`),
          )
          .mutEntry(
            key,
            (entry) => entry || error(`Entry ${bin2str(key)} not found`),
          ),
      fsRoot,
    );

  const execMkdir = ({ at }: MkdirExec) => {
    const atKey = at.pop();
    if (!atKey) {
      error(`Must provide a non-root "at" path`);
    }

    lookupPath(at)
      .dispatch({ dir: (dir: FsDirNode) => dir }, () => error(`Not a dir`))
      .mutEntry(
        atKey!,
        (node) =>
          node
            ? error(`Entry ${bin2str(atKey!)} already exists`)
            : { val: memFs.createDirNode(), capMask: FS_CAPABILITY_ALL },
      );
  };

  const execLink = ({ from, to }: LinkExec) => {
    const toKey = to.pop();
    if (!toKey) {
      error(`Must provide a non-root "to" path`);
    }

    const fromNode = lookupPath(from);
    const toNode = lookupPath(to);
    toNode
      .dispatch({ dir: (dir: FsDirNode) => dir }, () => error(`Not a dir`))
      .mutEntry(
        toKey!,
        (node) =>
          node
            ? error(`Entry ${bin2str(toKey!)} already exists`)
            : { val: fromNode, capMask: FS_CAPABILITY_ALL },
      );
  };

  const inDir = fsRoot.mutEntry(
    str2bin('in'),
    (entry) =>
      entry ? error(`/in already exists`) : {
        val: memFs.createDirNode(),
        capMask: FS_CAPABILITY_DIR_LIST_ENTRIES |
          FS_CAPABILITY_DIR_READ_ENTRY |
          FS_CAPABILITY_FILE_READ,
      },
  );
  const outDir = fsRoot.mutEntry(
    str2bin('out'),
    (entry) =>
      entry ? error(`/out already exists`) : {
        val: memFs.createDirNode(),
        capMask: FS_CAPABILITY_DIR_LIST_ENTRIES |
          FS_CAPABILITY_DIR_READ_ENTRY |
          FS_CAPABILITY_DIR_ENTRY_CREATE |
          FS_CAPABILITY_DIR_ENTRY_REMOVE |
          FS_CAPABILITY_FILE_READ |
          FS_CAPABILITY_FILE_WRITE,
      },
  );
  const devDir = fsRoot.mutEntry(
    str2bin('dev'),
    (entry) =>
      entry ? error(`/dev already exists`) : {
        val: memFs.createDirNode(),
        capMask: FS_CAPABILITY_DIR_LIST_ENTRIES |
          FS_CAPABILITY_DIR_READ_ENTRY |
          FS_CAPABILITY_FILE_READ,
      },
  );

  const randomBytes = new Uint8Array(1024);
  crypto.getRandomValues(randomBytes);
  devDir.mutEntry(
    str2bin('urandom'),
    (entry) =>
      entry ? error(`/dev/urandom already exists`) : {
        val: memFs.createFileNode(),
        capMask: FS_CAPABILITY_FILE_READ,
      },
  ).write(0, [randomBytes]);

  wasiParams.files.forEach(({ path, contents }) => {
    const file = inDir.mutEntry(
      str2bin(path),
      (entry) =>
        entry ? error(`/in/${path} already exists`) : {
          val: memFs.createFileNode(),
          capMask: FS_CAPABILITY_FILE_READ,
        },
    );
    file.write(0, [contents]);
  });

  inDir.mutEntry(
    str2bin('params'),
    (entry) =>
      entry ? error(`/in/params already exists`) : {
        val: memFs.createFileNode(),
        capMask: FS_CAPABILITY_FILE_READ,
      },
  ).write(0, [makeClientUtils(client).callReader('readParams')]);

  const createResultNode = () => {
    const inode = inodeSource.nextInode++;
    let contents = new Uint8Array();

    return {
      getFs() {
        return memFs;
      },
      getInode() {
        return inode;
      },

      dispatch<T>(
        { file }: { file?: (file: FsFileNode) => T },
        defaultHandler?: (node: FsNode) => T,
      ): T {
        return (file || defaultHandler)!(this);
      },

      read(offset: number, dstBufs: Uint8Array[]) {
        throw new Error(`ResultFs does not support file reading`);
      },

      write(offset: number, bufs: Uint8Array[]) {
        const end = bufs.reduce((acc, buf) => acc + buf.byteLength, offset);

        if (end > contents.byteLength) {
          const newContents = new Uint8Array(end);
          newContents.set(contents);
          contents = newContents;
        }

        const begin = offset;
        for (const buf of bufs) {
          contents.set(buf, offset);
          offset += buf.byteLength;
        }

        client.inform('outputChunk', ['stdout', 0, contents], []);
        return offset - begin;
      },

      getSize() {
        throw new Error(`ResultFs does not support file reading`);
      },

      resize(size: number) {
        const newContents = new Uint8Array(size);
        newContents.set(contents);
        contents = newContents;
        client.inform('outputChunk', ['stdout', 0, contents], []);
      },
    };
  };
  outDir.mutEntry(
    str2bin('stdout'),
    (entry) =>
      entry ? error(`/out/stdout already exists`) : {
        val: createResultNode(),
        capMask: FS_CAPABILITY_FILE_WRITE,
      },
  );

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
  //       error(
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

  // const args = [
  //   ...bin2str(inputs.params).matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g),
  // ].map((m) => m[1] || m[2] || m[3]);
  // logger.info('ARGS', args);

  const wasi = new WasiImpl(
    wasiParams.argv,
    wasiParams.env,
    wasiParams.cwd,
    logger,
  );

  const rootHandle = wasi.makeHandle(fsRoot, FS_CAPABILITY_ALL);
  const lookupWasiPath = (
    path: Uint8Array[],
    create: boolean,
  ): FsNodeHandle => {
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
              : error(`Path ${formatPath(path)} does not exist`)),
        ),
      rootHandle,
    );
  };

  wasi.resetFds(
    lookupWasiPath(wasiParams.stdinFrom, false),
    lookupWasiPath(wasiParams.stdoutTo, true),
    lookupWasiPath(wasiParams.stderrTo, true),
    [[]].map((path) => ({ path, handle: lookupWasiPath(path, true) })),
  );

  return wasi;

  // Object.entries(outputSpec).forEach(([key, _]) => {
  //   const file = outDir
  //     .mutEntry(str2bin(key), (entry) => entry)
  //     ?.dispatch(
  //       { file: (file: FsFileNode) => file },
  //       () => error(`/out/${key} is not a file`),
  //     ) || memFs.createFileNode();

  //   const CHUNK_SIZE = 65536;
  //   let offset = 0;
  //   while (true) {
  //     const chunk = new Uint8Array(CHUNK_SIZE);
  //     const read = file.read(offset, [chunk]);
  //     if (read !== CHUNK_SIZE) {
  //       client.inform(
  //         'outputChunk',
  //         [key, offset, chunk.subarray(0, read)],
  //         [chunk.buffer],
  //       );
  //       break;
  //     } else {
  //       client.inform('outputChunk', [key, offset, chunk], [chunk.buffer]);
  //       offset += CHUNK_SIZE;
  //     }
  //   }
  // });
};
