import { WorkerChannelClient } from './WorkerChannel.ts';
import { WorkerComm } from './workerTypes.ts';
import { JobMessage } from './workerTypes.ts';
import { BaseImports } from './execJob.ts';
import { LockWrapperParams } from '../messages.ts';
import { bin2hex } from '../util/hex.ts';
import { WasiError, WasiImpl } from './WasiImpl.ts';
import * as wc from './WasiConstants.ts';
import { bin2str } from '../util/buffer.ts';

const throwWasiErr = (code: number): never => {
  throw new WasiError(code);
};
const has = (superset: number, subset: number) => (~superset & subset) === 0;

const oldWasiPathOpen = (
  wasi: WasiImpl,
  memory: WebAssembly.Memory,
  keys: Uint8Array[],
  dirFd: number,
  dirflags: number,
  pathPtr: number,
  pathLen: number,
  oflags: number,
  fsRightsBase: bigint | number,
  fsRightsInheriting: bigint | number,
  fdFlags: number,
  fdDst: number,
) => {
  const hdl = wasi.getFd(dirFd);

  const lastKey = keys.pop()!;
  const dirHdl = keys.reduce(
    (curHdl, curKey) =>
      curHdl.dirMutEntry(curKey, (val) => val) ||
      throwWasiErr(wc.WASI_ENOENT),
    hdl,
  );

  const childHdl = dirHdl.dirMutEntry(lastKey, (val) => {
    has(oflags, wc.WASI_O_DIRECTORY) &&
      !val?.dispatch({ dir: () => true }, () => false) &&
      throwWasiErr(wc.WASI_ENOTDIR);

    has(oflags, wc.WASI_O_CREAT | wc.WASI_O_EXCL) &&
      val &&
      throwWasiErr(wc.WASI_EEXIST);

    has(oflags, wc.WASI_O_TRUNC) &&
      val?.dispatch({ file: (file) => file.resize(0) }, () => {});

    return (
      val ||
      (has(oflags, wc.WASI_O_CREAT)
        ? dirHdl.node.getFs().createFileNode()
        : undefined)
    );
  }) || throwWasiErr(wc.WASI_ENOENT);

  if (has(fdFlags, wc.WASI_FDFLAG_APPEND)) {
    childHdl.fileOffset = childHdl.fileGetSize();
  }
  if (has(fdFlags, wc.WASI_FDFLAG_NONBLOCK)) {
    childHdl.fileIsBlocking = false;
  }

  const childFd = wasi.allocFd(childHdl);

  const view = new DataView(memory.buffer);
  view.setUint32(fdDst, childFd, true);

  return wc.WASI_ESUCCESS;
};

export const makeLockWrapper = (
  client: WorkerChannelClient<WorkerComm>,
  lockParamBytes: Uint8Array,
  job: JobMessage,
  baseImports: BaseImports,
  wasi: WasiImpl,
) => {
  const { mapping, development } = LockWrapperParams.decode(lockParamBytes);
  const map = new Map(mapping.map(({ from, to }) => [bin2hex(from), to]));

  let memory: WebAssembly.Memory | undefined;

  const wasi_path_open = (
    dirFd: number,
    dirflags: number,
    pathPtr: number,
    pathLen: number,
    oflags: number,
    fsRightsBase: bigint | number,
    fsRightsInheriting: bigint | number,
    fdFlags: number,
    fdDst: number,
  ) => {
    const path = new Uint8Array(memory!.buffer, pathPtr, pathLen);

    const to = map.get(bin2hex(path));
    if (to !== undefined) {
      return oldWasiPathOpen(
        wasi,
        memory!,
        to,
        dirFd,
        dirflags,
        pathPtr,
        pathLen,
        oflags,
        fsRightsBase,
        fsRightsInheriting,
        fdFlags,
        fdDst,
      );
    } else if (development && URL.canParse(bin2str(path))) {
    } else {
    }

    this.logger.info(
      `wasi_path_open`,
      {
        dirFd,
        dirflags,
        pathPtr,
        pathLen,
        oflags,
        fsRightsBase,
        fsRightsInheriting,
        fdFlags,
        fdDst,
      },
    );
    const hdl = this.handles.get(dirFd) || throwWasiErr(wc.WASI_EBADF);
    // TODO: Handle rights better here (map them to our rights)

    this.logger.info('path_open', { path: bin2str(path) });
  };

  const imports = {
    ...baseImports,
    wasi_snapshot_preview1: {
      ...baseImports.wasi_snapshot_preview1,
      wasi_path_open,
    },
  };

  const setMemory = (newMemory: WebAssembly.Memory) => memory = newMemory;

  const cleanup = development
    ? () =>
      console.log(
        `Production mapping params for lock wrapper:`,
        bin2hex(LockWrapperParams.encode({ mapping, development: false })),
      )
    : () => {};

  return { imports, setMemory, cleanup };
};
