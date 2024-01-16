/*
This file is based on the implementation here:
https://github.com/wasmerio/wasmer-js/blob/24f5508731c9b58371e4276ec8965dc1c48b5178/packages/wasi/src/index.ts

Also useful: https://deno.land/std@0.142.0/wasi/snapshot_preview1.ts

Original work: Copyright 2019 Gus Caplan
Modified work: Copyright 2021 Joel Walker

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
*/

import {
  FS_CAPABILITY_ALL,
  FS_CAPABILITY_DIR_ENTRY_CREATE,
  FS_CAPABILITY_DIR_ENTRY_REMOVE,
  FS_CAPABILITY_DIR_LIST_ENTRIES,
  FS_CAPABILITY_DIR_READ_ENTRY,
  FS_CAPABILITY_FILE_READ,
  FS_CAPABILITY_FILE_WRITE,
  FsCapabilityMask,
  FsDirEntry,
  FsDirNode,
  FsFileNode,
  FsNode,
} from './fsTypes.ts';
import * as wc from './WasiConstants.ts';
import { log } from '../../deps.ts';
import { bin2str, str2bin } from '../util/buffer.ts';
import { decodePathEntry, formatPath } from './pathUtils.ts';

const traceSyscalls = true;
const exposeInodes = false;
const enableRandom = true;
const enableTime = true;

const has = (superset: number, subset: number) => (~superset & subset) === 0;

export interface FsNodeHandle {
  node: FsNode;
  capMask: FsCapabilityMask;
  fileOffset: number;
  fileIsBlocking: boolean;
  preopenPath?: Uint8Array;

  dirListEntries(): FsDirEntry[];
  dirMutEntry(
    key: Uint8Array,
    mutator: (entry: FsNode | undefined) => undefined,
  ): undefined;
  dirMutEntry<NodeExt extends FsNode>(
    key: Uint8Array,
    mutator: (entry: FsNode | undefined) => NodeExt,
  ): FsNodeHandle;
  dirMutEntry<NodeExt extends FsNode>(
    key: Uint8Array,
    mutator: (entry: FsNode | undefined) => NodeExt | undefined,
  ): FsNodeHandle | undefined;

  fileRead(offset: number, dstBufs: Uint8Array[]): number;
  fileWrite(offset: number, bufs: Uint8Array[]): number;
  fileGetSize(): number;
  fileResize(size: number): void;
}

export class WasiError extends Error {
  constructor(public errno: number) {
    super(`WasiError(${errno})`);
    Object.setPrototypeOf(this, WasiError.prototype);
  }
}

export class WasiExit extends Error {
  constructor(public code: number) {
    super(`WasiExit(${code})`);
    Object.setPrototypeOf(this, WasiExit.prototype);
  }
}

const throwWasiErr = (code: number): never => {
  throw new WasiError(code);
};

const wrapWasi =
  <T extends (...args: any[]) => number>(f: T) =>
  (...args: Parameters<T>): number => {
    try {
      return f(...args);
    } catch (err) {
      if (err instanceof WasiError) {
        // If it's a WASI error, we return it directly
        return err.errno;
      } else {
        // Otherwise we let the error bubble up
        throw err;
      }
    }
  };

// export const FS_CAPABILITY_DIR_LIST_ENTRIES: FsCapabilityMask = 1 << 0;
// export const FS_CAPABILITY_DIR_READ_ENTRY: FsCapabilityMask = 1 << 1;
// export const FS_CAPABILITY_DIR_ENTRY_CREATE: FsCapabilityMask = 1 << 2;
// export const FS_CAPABILITY_DIR_ENTRY_REMOVE: FsCapabilityMask = 1 << 3;
// export const FS_CAPABILITY_FILE_READ: FsCapabilityMask = 1 << 4;
// export const FS_CAPABILITY_FILE_WRITE: FsCapabilityMask = 1 << 5;
// export const FS_CAPABILITY_ALL: FsCapabilityMask = (1 << 6) - 1;

const getBaseRights = (capMask: FsCapabilityMask) => {
  let res = 0n;
  if (capMask & FS_CAPABILITY_DIR_LIST_ENTRIES) {
    res |= wc.WASI_RIGHT_PATH_LINK_SOURCE | wc.WASI_RIGHT_FD_READDIR |
      wc.WASI_RIGHT_PATH_RENAME_SOURCE;
  }
  if (capMask & FS_CAPABILITY_DIR_READ_ENTRY) {
    res |= wc.WASI_RIGHT_PATH_LINK_SOURCE | wc.WASI_RIGHT_PATH_OPEN |
      wc.WASI_RIGHT_PATH_READLINK | wc.WASI_RIGHT_PATH_RENAME_SOURCE |
      wc.WASI_RIGHT_PATH_FILESTAT_GET | wc.WASI_RIGHT_PATH_FILESTAT_SET_SIZE |
      wc.WASI_RIGHT_PATH_FILESTAT_SET_TIMES;
  }
  if (capMask & FS_CAPABILITY_DIR_ENTRY_CREATE) {
    res |= wc.WASI_RIGHT_PATH_CREATE_DIRECTORY |
      wc.WASI_RIGHT_PATH_CREATE_FILE | wc.WASI_RIGHT_PATH_LINK_TARGET |
      wc.WASI_RIGHT_PATH_RENAME_TARGET | wc.WASI_RIGHT_PATH_SYMLINK;
  }
  if (capMask & FS_CAPABILITY_DIR_ENTRY_REMOVE) {
    res |= wc.WASI_RIGHT_PATH_REMOVE_DIRECTORY | wc.WASI_RIGHT_PATH_UNLINK_FILE;
  }
  if (capMask & FS_CAPABILITY_FILE_READ) {
    res |= wc.WASI_RIGHT_FD_DATASYNC | wc.WASI_RIGHT_FD_READ |
      wc.WASI_RIGHT_FD_SEEK | wc.WASI_RIGHT_FD_FDSTAT_SET_FLAGS |
      wc.WASI_RIGHT_FD_SYNC | wc.WASI_RIGHT_FD_TELL | wc.WASI_RIGHT_FD_ADVISE |
      wc.WASI_RIGHT_FD_FILESTAT_GET | wc.WASI_RIGHT_POLL_FD_READWRITE;
  }
  if (capMask & FS_CAPABILITY_FILE_WRITE) {
    res |= wc.WASI_RIGHT_FD_DATASYNC | wc.WASI_RIGHT_FD_SEEK |
      wc.WASI_RIGHT_FD_FDSTAT_SET_FLAGS | wc.WASI_RIGHT_FD_SYNC |
      wc.WASI_RIGHT_FD_TELL | wc.WASI_RIGHT_FD_WRITE | wc.WASI_RIGHT_FD_ADVISE |
      wc.WASI_RIGHT_FD_ALLOCATE | wc.WASI_RIGHT_FD_FILESTAT_SET_SIZE |
      wc.WASI_RIGHT_FD_FILESTAT_SET_TIMES | wc.WASI_RIGHT_POLL_FD_READWRITE;
  }
  return res;
};

const getInheritingRights = (capMask: FsCapabilityMask) => {
  if (
    capMask &
    (FS_CAPABILITY_DIR_LIST_ENTRIES | FS_CAPABILITY_DIR_READ_ENTRY |
      FS_CAPABILITY_DIR_ENTRY_CREATE | FS_CAPABILITY_DIR_ENTRY_REMOVE)
  ) {
    return getBaseRights(FS_CAPABILITY_ALL);
  } else {
    return getBaseRights(capMask);
  }
};

export default class WasiImpl {
  private memory?: WebAssembly.Memory;
  private handles: Map<number, FsNodeHandle> = new Map();
  private fdIt: number = 1;

  constructor(
    private argv: Uint8Array[],
    private env: { key: Uint8Array; val: Uint8Array }[],
    private cwd: Uint8Array[],
    private logger: log.Logger,
  ) {
    this.logger.info('WasiImpl constructor', { argv, env, cwd });
  }

  public setMemory(memory: WebAssembly.Memory) {
    this.memory = memory;
  }

  public makeHandle(node: FsNode, capMask: FsCapabilityMask): FsNodeHandle {
    const topThis = this;

    return {
      node,
      capMask,
      fileOffset: 0,
      fileIsBlocking: true,

      dirListEntries() {
        return node.dispatch(
          {
            dir: (dir: FsDirNode) =>
              capMask & FS_CAPABILITY_DIR_LIST_ENTRIES
                ? dir.listEntries()
                : throwWasiErr(wc.WASI_ENOTCAPABLE),
          },
          () => throwWasiErr(wc.WASI_ENOTDIR),
        );
      },

      // @ts-ignore: TS can't verify that undef -> undef, NE -> FNE, and undef|NE -> undef|FNE
      dirMutEntry<NodeExt extends FsNode>(
        key: Uint8Array,
        mutator: (entry: FsNode | undefined) => NodeExt | undefined,
      ) {
        let newMask = capMask;
        const newNode = node.dispatch(
          {
            dir: (dir: FsDirNode) =>
              capMask & FS_CAPABILITY_DIR_READ_ENTRY
                ? dir.mutEntry(key, (entry: FsDirEntry | undefined) => {
                  const before = entry?.val;
                  const after = mutator(before);
                  if (after !== before) {
                    if (
                      after &&
                      !(capMask & FS_CAPABILITY_DIR_ENTRY_CREATE)
                    ) {
                      throwWasiErr(wc.WASI_ENOTCAPABLE);
                    }
                    if (
                      before &&
                      !(capMask & FS_CAPABILITY_DIR_ENTRY_REMOVE)
                    ) {
                      throwWasiErr(wc.WASI_ENOTCAPABLE);
                    }
                    return (
                      after && { val: after, capMask: FS_CAPABILITY_ALL }
                    );
                  } else {
                    newMask &= entry ? entry.capMask : 0;
                    return entry;
                  }
                })
                : throwWasiErr(wc.WASI_ENOTCAPABLE),
          },
          () => throwWasiErr(wc.WASI_ENOTDIR),
        );
        return newNode && topThis.makeHandle(newNode, newMask);
      },

      fileRead(offset: number, dstBufs: Uint8Array[]) {
        return node.dispatch(
          {
            file: (file: FsFileNode) =>
              capMask & FS_CAPABILITY_FILE_READ
                ? file.read(offset, dstBufs)
                : throwWasiErr(wc.WASI_ENOTCAPABLE),
          },
          () => throwWasiErr(wc.WASI_EISDIR),
        );
      },

      fileWrite(offset: number, bufs: Uint8Array[]) {
        return node.dispatch(
          {
            file: (file: FsFileNode) =>
              capMask & FS_CAPABILITY_FILE_WRITE
                ? file.write(offset, bufs)
                : throwWasiErr(wc.WASI_ENOTCAPABLE),
          },
          () => throwWasiErr(wc.WASI_EISDIR),
        );
      },

      fileGetSize() {
        return node.dispatch(
          {
            file: (file: FsFileNode) =>
              capMask & FS_CAPABILITY_FILE_READ
                ? file.getSize()
                : throwWasiErr(wc.WASI_ENOTCAPABLE),
          },
          () => throwWasiErr(wc.WASI_EISDIR),
        );
      },

      fileResize(size: number) {
        return node.dispatch(
          {
            file: (file: FsFileNode) =>
              capMask & FS_CAPABILITY_FILE_WRITE
                ? file.resize(size)
                : throwWasiErr(wc.WASI_ENOTCAPABLE),
          },
          () => throwWasiErr(wc.WASI_EISDIR),
        );
      },
    };
  }

  public resetFds(
    stdinFrom: FsNodeHandle,
    stdoutTo: FsNodeHandle,
    stderrTo: FsNodeHandle,
    preopens: { path: Uint8Array[]; handle: FsNodeHandle }[],
  ) {
    this.handles.clear();
    this.fdIt = 1;

    this.handles.set(0, stdinFrom);
    this.handles.set(1, stdoutTo);
    this.handles.set(2, stderrTo);

    preopens.forEach(({ path, handle }, i) => {
      handle.preopenPath = str2bin(formatPath(path));
      this.handles.set(3 + i, handle);
    });
  }

  public getImports() {
    return Object.fromEntries(
      Object.getOwnPropertyNames(this.constructor.prototype)
        .map((key) => key.match(/^wasi_(.+)$/))
        .filter(<T>(x: T | null): x is T => !!x)
        .map(([methodName, abiName]) => {
          const method = (this as any)[methodName].bind(this);
          return [
            abiName,
            wrapWasi(
              traceSyscalls
                ? (...args: any[]) => {
                  this.logger.info('WASI CALL', { abiName, args });
                  try {
                    const result = method(...args);
                    this.logger.info('WASI RETURN', { result });
                    return result;
                  } catch (err) {
                    this.logger.info('WASI ERROR', { err });
                    throw err;
                  }
                }
                : method,
            ),
          ];
        }),
    );
  }

  // public run(inst: WebAssembly.Instance): number {
  //   this.logger.info('Running...', {});
  //   try {
  //     (inst.exports._start as CallableFunction)();
  //   } catch (err) {
  //     if (err instanceof WasiExit) {
  //       // If it's a normal WASI exit, we return it directly
  //       this.logger.warning(
  //         `Ended with code ${err.code}`,
  //         { err, code: err.code },
  //       );
  //       return err.code;
  //     } else {
  //       // Otherwise we let the error bubble up
  //       this.logger.error(`Ended with unhandlable error`, { err });
  //       throw err;
  //     }
  //   }

  //   this.logger.info('Ended successfully', {});
  //   return 0;
  // }

  private advanceFdIt(): number {
    // LFSR
    // Will cycle through every 31-bit number before repeating
    this.fdIt ^= this.fdIt << 13;
    this.fdIt ^= this.fdIt >>> 17;
    this.fdIt ^= this.fdIt << 5;
    this.fdIt &= 0x7fffffff;
    return this.fdIt;
  }

  public allocFd(hdl: FsNodeHandle): number {
    let fd;
    do {
      fd = this.advanceFdIt();
    } while (this.handles.has(fd));
    this.handles.set(fd, hdl);
    return fd;
  }
  public getFd(fd: number) {
    return this.handles.get(fd) ?? throwWasiErr(wc.WASI_EBADF);
  }
  public releaseFd(fd: number) {
    this.handles.delete(fd);
  }

  private getIovs(iovs: number, iovsLen: number) {
    if (iovs + iovsLen * 8 > this.memory!.buffer.byteLength) {
      throw new Error(
        `Trying to read up to ${iovs} but memory is only ${
          this.memory!.buffer.byteLength
        } bytes`,
      );
    }
    this.logger.info('max', { max: this.memory!.buffer.byteLength });

    const view = new DataView(this.memory!.buffer);

    return Array.from({ length: iovsLen }, (_, i) => {
      const offset = view.getUint32(iovs, true);
      iovs += 4;
      const size = view.getUint32(iovs, true);
      iovs += 4;
      return new Uint8Array(this.memory!.buffer, offset, size);
    });
  }

  private wasi_args_get(dstPtrs: number, dstBuf: number) {
    this.logger.info(`wasi_args_get`, { dstPtrs, dstBuf });
    const view = new DataView(this.memory!.buffer);
    const bytes = new Uint8Array(this.memory!.buffer);
    this.argv.forEach((arg) => {
      // Write ptr to arg
      view.setUint32(dstPtrs, dstBuf, true);
      dstPtrs += 4;
      // Write arg data
      bytes.set(arg, dstBuf);
      dstBuf += arg.length;
      // Write null byte
      bytes[dstBuf] = 0;
      dstBuf++;
    });
    return wc.WASI_ESUCCESS;
  }

  private wasi_args_sizes_get(dstArgc: number, dstBufSize: number) {
    this.logger.info(`wasi_args_sizes_get`, { dstArgc, dstBufSize });
    const view = new DataView(this.memory!.buffer);
    view.setUint32(dstArgc, this.argv.length, true);
    const size = this.argv.reduce((acc, arg) => acc + arg.length + 1, 0);
    view.setUint32(dstBufSize, size, true);
    return wc.WASI_ESUCCESS;
  }

  private wasi_environ_get(dstPtrs: number, dstBuf: number) {
    this.logger.info(`wasi_environ_get`, { dstPtrs, dstBuf });
    const view = new DataView(this.memory!.buffer);
    const bytes = new Uint8Array(this.memory!.buffer);
    this.env.forEach(({ key, val }) => {
      // Write ptr to arg
      view.setUint32(dstPtrs, dstBuf, true);
      dstPtrs += 4;
      // Write key data
      bytes.set(key, dstBuf);
      dstBuf += key.length;
      // Write '=' byte
      bytes[dstBuf] = 61;
      dstBuf++;
      // Write val data
      bytes.set(val, dstBuf);
      dstBuf += val.length;
      // Write null byte
      bytes[dstBuf] = 0;
      dstBuf++;
    });
    return wc.WASI_ESUCCESS;
  }

  private wasi_environ_sizes_get(dstEnvCount: number, dstBufSize: number) {
    this.logger.info(`wasi_environ_sizes_get`, { dstEnvCount, dstBufSize });
    const view = new DataView(this.memory!.buffer);
    view.setUint32(dstEnvCount, this.env.length, true);
    const size = this.env.reduce(
      (acc, { key, val }) => acc + key.length + val.length + 2,
      0,
    );
    view.setUint32(dstBufSize, size, true);
    return wc.WASI_ESUCCESS;
  }

  private wasi_clock_res_get(clockId: number, resolution: number) {
    this.logger.info(`wasi_clock_res_get`, { clockId, resolution });
    const view = new DataView(this.memory!.buffer);
    switch (clockId) {
      case wc.WASI_CLOCK_REALTIME: {
        view.setBigUint64(resolution, 1000000n, true);
        break;
      }

      case wc.WASI_CLOCK_MONOTONIC:
      case wc.WASI_CLOCK_PROCESS_CPUTIME_ID:
      case wc.WASI_CLOCK_THREAD_CPUTIME_ID: {
        view.setBigUint64(resolution, 1000n, true);
        break;
      }

      default:
        return wc.WASI_EINVAL;
    }
    return wc.WASI_ESUCCESS;
  }

  private wasi_clock_time_get(
    clockId: number,
    precision: bigint,
    time: number,
  ) {
    this.logger.info(
      `wasi_clock_time_get`,
      { clockId, precision: Number(precision), time },
    );
    const view = new DataView(this.memory!.buffer);
    switch (clockId) {
      case wc.WASI_CLOCK_REALTIME: {
        const val = enableTime ? BigInt(Date.now()) * 1000000n : 0n;
        view.setBigUint64(time, val, true);
        break;
      }

      case wc.WASI_CLOCK_MONOTONIC:
      case wc.WASI_CLOCK_PROCESS_CPUTIME_ID:
      case wc.WASI_CLOCK_THREAD_CPUTIME_ID: {
        const val = enableTime
          ? BigInt(Math.round(performance.now() * 1e9))
          : 0n;
        view.setBigUint64(time, val, true);
        break;
      }

      default:
        return wc.WASI_EINVAL;
    }
    return wc.WASI_ESUCCESS;
  }

  private wasi_fd_advise(
    fd: number,
    offset: number,
    len: number,
    advice: number,
  ) {
    this.logger.info(`wasi_fd_advise`, { fd, offset, len, advice });
    this.getFd(fd);
    return wc.WASI_ENOSYS;
  }

  private wasi_fd_allocate(fd: number, offset: number, len: number) {
    this.logger.info(`wasi_fd_allocate`, { fd, offset, len });
    this.getFd(fd);
    return wc.WASI_ENOSYS;
  }

  private wasi_fd_close(fd: number) {
    this.logger.info(`wasi_fd_close`, { fd });
    const hdl = this.getFd(fd);
    this.handles.delete(fd);
    return wc.WASI_ESUCCESS;
  }

  private wasi_fd_datasync(fd: number) {
    this.logger.info(`wasi_fd_datasync`, { fd });
    const hdl = this.getFd(fd);
    return wc.WASI_ESUCCESS;
  }

  private wasi_fd_fdstat_get(fd: number, dstBuf: number) {
    this.logger.info(`wasi_fd_fdstat_get`, { fd, dstBuf });
    const hdl = this.getFd(fd);
    const view = new DataView(this.memory!.buffer);
    view.setUint8(
      dstBuf,
      hdl.node.dispatch({
        dir: () => wc.WASI_FILETYPE_DIRECTORY,
        file: () => wc.WASI_FILETYPE_REGULAR_FILE,
      }),
    ); // fs_filetype
    view.setUint16(
      dstBuf + 2,
      hdl.fileIsBlocking ? 0 : wc.WASI_FDFLAG_NONBLOCK,
      true,
    ); // fs_flags
    view.setBigUint64(dstBuf + 8, getBaseRights(hdl.capMask), true); // fs_rights_base
    view.setBigUint64(dstBuf + 16, getInheritingRights(hdl.capMask), true); // fs_rights_inheriting
    return wc.WASI_ESUCCESS;
  }

  private wasi_fd_fdstat_set_flags(fd: number, flags: number) {
    this.logger.info(`wasi_fd_fdstat_set_flags`, { fd, flags });
    const hdl = this.getFd(fd);
    hdl.fileOffset = has(flags, wc.WASI_FDFLAG_APPEND) ? hdl.fileGetSize() : 0;
    hdl.fileIsBlocking = !has(flags, wc.WASI_FDFLAG_NONBLOCK);
    return wc.WASI_ESUCCESS;
  }

  private wasi_fd_fdstat_set_rights(
    fd: number,
    fsRightsBase: bigint,
    fsRightsInheriting: bigint,
  ) {
    this.logger.info(
      `wasi_fd_fdstat_set_rights`,
      { fd, fsRightsBase, fsRightsInheriting },
    );
    const hdl = this.getFd(fd);
    return wc.WASI_ESUCCESS;
  }

  private wasi_fd_filestat_get(fd: number, bufPtr: number) {
    this.logger.info(`wasi_fd_filestat_get`, { fd, bufPtr });
    const hdl = this.getFd(fd);
    return wc.WASI_ENOSYS;
    /*
    const rstats = fs.fstatSync(stats.real);
    const view = new DataView(this.memory!.buffer);
    view.setBigUint64(bufPtr, BigInt(rstats.dev), true);
    bufPtr += 8;
    view.setBigUint64(bufPtr, BigInt(rstats.ino), true);
    bufPtr += 8;
    view.setUint8(bufPtr, stats.filetype);
    bufPtr += 8;
    view.setBigUint64(bufPtr, BigInt(rstats.nlink), true);
    bufPtr += 8;
    view.setBigUint64(bufPtr, BigInt(rstats.size), true);
    bufPtr += 8;
    view.setBigUint64(bufPtr, msToNs(rstats.atimeMs), true);
    bufPtr += 8;
    view.setBigUint64(bufPtr, msToNs(rstats.mtimeMs), true);
    bufPtr += 8;
    view.setBigUint64(bufPtr, msToNs(rstats.ctimeMs), true);
    return wc.WASI_ESUCCESS;
    */
  }

  private wasi_fd_filestat_set_size(fd: number, stSize: number) {
    this.logger.info(`wasi_fd_filestat_set_size`, { fd, stSize });
    const hdl = this.getFd(fd);
    return wc.WASI_ENOSYS;
    /*
    fs.ftruncateSync(stats.real, Number(stSize));
    return wc.WASI_ESUCCESS;
    */
  }

  private wasi_fd_filestat_set_times(
    fd: number,
    stAtim: number,
    stMtim: number,
    fstflags: number,
  ) {
    this.logger.info(
      `wasi_fd_filestat_set_times`,
      { fd, stAtim, stMtim, fstflags },
    );
    const hdl = this.getFd(fd);
    return wc.WASI_ENOSYS;
    /*
      const rstats = fs.fstatSync(stats.real);
      let atim = rstats.atime;
      let mtim = rstats.mtime;
      const atimflags =
        wc.WASI_FILESTAT_SET_ATIM | wc.WASI_FILESTAT_SET_ATIM_NOW;
      if ((fstflags & atimflags) === atimflags) {
        return wc.WASI_EINVAL;
      }
      const mtimflags =
        wc.WASI_FILESTAT_SET_MTIM | wc.WASI_FILESTAT_SET_MTIM_NOW;
      if ((fstflags & mtimflags) === mtimflags) {
        return wc.WASI_EINVAL;
      }
      if (
        (fstflags & wc.WASI_FILESTAT_SET_ATIM) ===
        wc.WASI_FILESTAT_SET_ATIM
      ) {
        atim = nsToMs(stAtim);
      } else if (
        (fstflags & wc.WASI_FILESTAT_SET_ATIM_NOW) ===
        wc.WASI_FILESTAT_SET_ATIM_NOW
      ) {
        atim = 0;
      }
      if (
        (fstflags & wc.WASI_FILESTAT_SET_MTIM) ===
        wc.WASI_FILESTAT_SET_MTIM
      ) {
        mtim = nsToMs(stMtim);
      } else if (
        (fstflags & wc.WASI_FILESTAT_SET_MTIM_NOW) ===
        wc.WASI_FILESTAT_SET_MTIM_NOW
      ) {
        mtim = 0;
      }
      fs.futimesSync(stats.real, new Date(atim), new Date(mtim));
      return wc.WASI_ESUCCESS;
      */
  }

  private wasi_fd_prestat_get(fd: number, bufPtr: number) {
    this.logger.info(`wasi_fd_prestat_get`, { fd, bufPtr });
    const hdl = this.getFd(fd);
    if (!hdl.preopenPath) {
      return wc.WASI_EINVAL;
    }
    const view = new DataView(this.memory!.buffer);
    view.setUint8(bufPtr, wc.WASI_PREOPENTYPE_DIR);
    view.setUint32(bufPtr + 4, hdl.preopenPath.byteLength, true);
    return wc.WASI_ESUCCESS;
  }

  private wasi_fd_prestat_dir_name(
    fd: number,
    pathPtr: number,
    pathLen: number,
  ) {
    this.logger.info(`wasi_fd_prestat_dir_name`, { fd, pathPtr, pathLen });
    const hdl = this.getFd(fd);
    if (!hdl.preopenPath) {
      return wc.WASI_EINVAL;
    }
    new Uint8Array(this.memory!.buffer, pathPtr, pathLen).set(
      hdl.preopenPath.subarray(0, pathLen), // TODO: Why is this subarray necessary???
    );
    return wc.WASI_ESUCCESS;
  }

  private wasi_fd_pwrite(
    fd: number,
    iovs: number,
    iovsLen: number,
    offset: number,
    dstSizeWritten: number,
  ) {
    this.logger.info(
      `wasi_fd_pwrite`,
      { fd, iovs, iovsLen, offset, dstSizeWritten },
    );
    const hdl = this.getFd(fd);
    const written = hdl.fileWrite(offset, this.getIovs(iovs, iovsLen));
    const view = new DataView(this.memory!.buffer);
    view.setUint32(dstSizeWritten, written, true);
    return wc.WASI_ESUCCESS;
  }

  private wasi_fd_write(
    fd: number,
    iovs: number,
    iovsLen: number,
    dstSizeWritten: number,
  ) {
    this.logger.info(`wasi_fd_write`, { fd, iovs, iovsLen, dstSizeWritten });
    const hdl = this.getFd(fd);
    const bufs = this.getIovs(iovs, iovsLen);
    this.logger.info(`fd_write_iovs`, { bufs: bufs.map(bin2str).join('') });
    const written = hdl.fileWrite(hdl.fileOffset, bufs);
    this.logger.info(`fd_write_wrote`, { written });
    hdl.fileOffset += written;
    const view = new DataView(this.memory!.buffer);
    view.setUint32(dstSizeWritten, written, true);
    return wc.WASI_ESUCCESS;
  }

  private wasi_fd_pread(
    fd: number,
    iovs: number,
    iovsLen: number,
    offset: number,
    dstSizeRead: number,
  ) {
    this.logger.info(
      `wasi_fd_pread`,
      { fd, iovs, iovsLen, offset, dstSizeRead },
    );
    const hdl = this.getFd(fd);
    const read = hdl.fileRead(offset, this.getIovs(iovs, iovsLen));
    const view = new DataView(this.memory!.buffer);
    view.setUint32(dstSizeRead, read, true);
    return wc.WASI_ESUCCESS;
  }

  private wasi_fd_read(
    fd: number,
    iovs: number,
    iovsLen: number,
    dstSizeRead: number,
  ) {
    this.logger.info(`wasi_fd_read`, { fd, iovs, iovsLen, dstSizeRead });
    const hdl = this.getFd(fd);
    const read = hdl.fileRead(hdl.fileOffset, this.getIovs(iovs, iovsLen));
    hdl.fileOffset += read;
    const view = new DataView(this.memory!.buffer);
    view.setUint32(dstSizeRead, read, true);
    return wc.WASI_ESUCCESS;
  }

  private wasi_fd_readdir(
    fd: number,
    dstBufPtr: number,
    dstBufSize: number,
    cookie: number,
    dstWrittenSize: number,
  ) {
    this.logger.info(
      `wasi_fd_readdir`,
      { fd, dstBufPtr, dstBufSize, cookie, dstWrittenSize },
    );
    const hdl = this.getFd(fd);
    const view = new DataView(this.memory!.buffer);
    const bytes = new Uint8Array(this.memory!.buffer);
    const dstBufEnd = dstBufPtr + dstBufSize;
    const entries = hdl.dirListEntries();
    for (let i = cookie; i < entries.length; i++) {
      const { key, val } = entries[i];

      // Write cookie for next
      if (dstBufPtr >= dstBufEnd) {
        break;
      }
      view.setBigUint64(dstBufPtr, BigInt(i + 1), true);
      dstBufPtr += 8;

      // Write inode
      if (dstBufPtr >= dstBufEnd) {
        break;
      }
      view.setBigUint64(
        dstBufPtr,
        BigInt(exposeInodes ? val.getInode() : 0),
        true,
      );
      dstBufPtr += 8;

      // Write name length
      if (dstBufPtr >= dstBufEnd) {
        break;
      }
      view.setUint32(dstBufPtr, key.length, true);
      dstBufPtr += 4;

      // Write filetype
      if (dstBufPtr >= dstBufEnd) {
        break;
      }
      view.setUint8(
        dstBufPtr,
        val.dispatch({
          dir: () => wc.WASI_FILETYPE_DIRECTORY,
          file: () => wc.WASI_FILETYPE_REGULAR_FILE,
        }),
      );
      dstBufPtr += 4;

      if (dstBufPtr + key.length > dstBufEnd) {
        break;
      }
      bytes.set(key, dstBufPtr);
      dstBufPtr += key.length;
    }
    view.setUint32(
      dstWrittenSize,
      dstBufSize - Math.max(dstBufEnd - dstBufPtr, 0),
      true,
    );
    return wc.WASI_ESUCCESS;
  }

  private wasi_fd_renumber(from: number, to: number) {
    this.logger.info(`wasi_fd_renumber`, { from, to });
    const fromHdl = this.getFd(from);
    const toHdl = this.getFd(to);
    this.handles.set(from, toHdl);
    this.handles.delete(to);
    return wc.WASI_ESUCCESS;
  }

  private wasi_fd_seek(
    fd: number,
    offset: number | bigint,
    whence: number,
    dstNewOffset: number,
  ) {
    this.logger.info(`wasi_fd_seek`, { fd, offset, whence, dstNewOffset });
    const hdl = this.getFd(fd);
    const view = new DataView(this.memory!.buffer);
    switch (whence) {
      case wc.WASI_WHENCE_SET:
        hdl.fileOffset = Number(offset);
        break;
      case wc.WASI_WHENCE_CUR:
        hdl.fileOffset += Number(offset);
        break;
      case wc.WASI_WHENCE_END:
        hdl.fileOffset = hdl.fileGetSize() + Number(offset);
        break;
    }
    hdl.fileOffset = Math.max(0, hdl.fileOffset);
    this.logger.info('fd_seek', { offset: hdl.fileOffset });
    view.setBigUint64(dstNewOffset, BigInt(hdl.fileOffset), true);
    return wc.WASI_ESUCCESS;
  }

  private wasi_fd_tell(fd: number, dstOffset: number) {
    this.logger.info(`wasi_fd_tell`, { fd, dstOffset });
    const hdl = this.getFd(fd);
    const view = new DataView(this.memory!.buffer);
    view.setBigUint64(dstOffset, BigInt(hdl.fileOffset), true);
    return wc.WASI_ESUCCESS;
  }

  private wasi_fd_sync(fd: number) {
    this.logger.info(`wasi_fd_sync`, { fd });
    const _hdl = this.getFd(fd);
    return wc.WASI_ESUCCESS;
  }

  private wasi_path_create_directory(
    fd: number,
    pathPtr: number,
    pathLen: number,
  ) {
    this.logger.info(`wasi_path_create_directory`, { fd, pathPtr, pathLen });
    const hdl = this.getFd(fd);
    const key = new Uint8Array(this.memory!.buffer, pathPtr, pathLen);
    hdl.dirMutEntry(
      key,
      (node) =>
        node ? throwWasiErr(wc.WASI_EEXIST) : hdl.node.getFs().createDirNode(),
    );
    return wc.WASI_ESUCCESS;
  }

  private wasi_path_filestat_get(
    fd: number,
    flags: number,
    pathPtr: number,
    pathLen: number,
    bufPtr: number,
  ) {
    this.logger.info(
      `wasi_path_filestat_get`,
      { fd, flags, pathPtr, pathLen, bufPtr },
    );
    const hdl = this.getFd(fd);
    return wc.WASI_ENOSYS;
    /*
      if (!stats.path) {
        return wc.WASI_EINVAL;
      }
      const view = new DataView(this.memory!.buffer);
      const p = Buffer.from(
        this.memory!.buffer,
        pathPtr,
        pathLen,
      ).toString();
      const rstats = fs.statSync(path.resolve(stats.path, p));
      view.setBigUint64(bufPtr, BigInt(rstats.dev), true);
      bufPtr += 8;
      view.setBigUint64(bufPtr, BigInt(rstats.ino), true);
      bufPtr += 8;
      view.setUint8(
        bufPtr,
        this.translateFileAttributes(this, undefined, rstats).filetype,
      );
      bufPtr += 8;
      view.setBigUint64(bufPtr, BigInt(rstats.nlink), true);
      bufPtr += 8;
      view.setBigUint64(bufPtr, BigInt(rstats.size), true);
      bufPtr += 8;
      view.setBigUint64(bufPtr, msToNs(rstats.atimeMs), true);
      bufPtr += 8;
      view.setBigUint64(bufPtr, msToNs(rstats.mtimeMs), true);
      bufPtr += 8;
      view.setBigUint64(bufPtr, msToNs(rstats.ctimeMs), true);
      return wc.WASI_ESUCCESS;
      */
  }

  private wasi_path_filestat_set_times(
    fd: number,
    dirflags: number,
    pathPtr: number,
    pathLen: number,
    stAtim: number,
    stMtim: number,
    fstflags: number,
  ) {
    this.logger.info(
      `wasi_path_filestat_set_times`,
      { fd, dirflags, pathPtr, pathLen, stAtim, stMtim, fstflags },
    );
    const hdl = this.getFd(fd);
    return wc.WASI_ENOSYS;
    /*
      if (!stats.path) {
        return wc.WASI_EINVAL;
      }
      const view = new DataView(this.memory!.buffer);
      const rstats = fs.fstatSync(stats.real);
      let atim = rstats.atime;
      let mtim = rstats.mtime;
      const n = nsToMs(now(wc.WASI_CLOCK_REALTIME)!);
      const atimflags =
        wc.WASI_FILESTAT_SET_ATIM | wc.WASI_FILESTAT_SET_ATIM_NOW;
      if ((fstflags & atimflags) === atimflags) {
        return wc.WASI_EINVAL;
      }
      const mtimflags =
        wc.WASI_FILESTAT_SET_MTIM | wc.WASI_FILESTAT_SET_MTIM_NOW;
      if ((fstflags & mtimflags) === mtimflags) {
        return wc.WASI_EINVAL;
      }
      if (
        (fstflags & wc.WASI_FILESTAT_SET_ATIM) ===
        wc.WASI_FILESTAT_SET_ATIM
      ) {
        atim = nsToMs(stAtim);
      } else if (
        (fstflags & wc.WASI_FILESTAT_SET_ATIM_NOW) ===
        wc.WASI_FILESTAT_SET_ATIM_NOW
      ) {
        atim = n;
      }
      if (
        (fstflags & wc.WASI_FILESTAT_SET_MTIM) ===
        wc.WASI_FILESTAT_SET_MTIM
      ) {
        mtim = nsToMs(stMtim);
      } else if (
        (fstflags & wc.WASI_FILESTAT_SET_MTIM_NOW) ===
        wc.WASI_FILESTAT_SET_MTIM_NOW
      ) {
        mtim = n;
      }
      const p = Buffer.from(
        this.memory!.buffer,
        pathPtr,
        pathLen,
      ).toString();
      fs.utimesSync(
        path.resolve(stats.path, p),
        new Date(atim),
        new Date(mtim),
      );
      return wc.WASI_ESUCCESS;
      */
  }

  private wasi_path_link(
    oldFd: number,
    oldFlags: number,
    oldPath: number,
    oldPathLen: number,
    newFd: number,
    newPath: number,
    newPathLen: number,
  ) {
    this.logger.info(
      `wasi_path_link`,
      { oldFd, oldFlags, oldPath, oldPathLen, newFd, newPath, newPathLen },
    );
    const ostats = this.getFd(oldFd);
    const nstats = this.getFd(newFd);
    return wc.WASI_ENOSYS;
    /*
      if (!ostats.path || !nstats.path) {
        return wc.WASI_EINVAL;
      }
      const view = new DataView(this.memory!.buffer);
      const op = Buffer.from(
        this.memory!.buffer,
        oldPath,
        oldPathLen,
      ).toString();
      const np = Buffer.from(
        this.memory!.buffer,
        newPath,
        newPathLen,
      ).toString();
      fs.linkSync(
        path.resolve(ostats.path, op),
        path.resolve(nstats.path, np),
      );
      return wc.WASI_ESUCCESS;
      */
  }

  private wasi_path_open(
    dirFd: number,
    dirflags: number,
    pathPtr: number,
    pathLen: number,
    oflags: number,
    fsRightsBase: bigint | number,
    fsRightsInheriting: bigint | number,
    fdFlags: number,
    fdDst: number,
  ) {
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
    const hdl = this.getFd(dirFd);
    // TODO: Handle rights better here (map them to our rights)

    const path = new Uint8Array(this.memory!.buffer, pathPtr, pathLen);
    this.logger.info('path_open', { path: bin2str(path) });

    const keys: Uint8Array[] = [];
    for (let offset = 0; true;) {
      const split = path.indexOf('/'.charCodeAt(0), offset);
      if (split === -1) {
        keys.push(decodePathEntry(path.subarray(offset)));
        break;
      } else {
        keys.push(decodePathEntry(path.subarray(offset, split)));
        offset = split + 1;
      }
    }
    this.logger.info('path_open', { keys: keys.map(bin2str) });

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

    const childFd = this.allocFd(childHdl);

    const view = new DataView(this.memory!.buffer);
    view.setUint32(fdDst, childFd, true);

    return wc.WASI_ESUCCESS;
  }

  private wasi_path_readlink(
    fd: number,
    pathPtr: number,
    pathLen: number,
    buf: number,
    bufLen: number,
    bufused: number,
  ) {
    this.logger.info(
      `wasi_path_readlink`,
      { fd, pathPtr, pathLen, buf, bufLen, bufused },
    );
    const hdl = this.getFd(fd);
    return wc.WASI_ENOSYS;

    /*
      if (!stats.path) {
        return wc.WASI_EINVAL;
      }
      const view = new DataView(this.memory!.buffer);
      const p = Buffer.from(
        this.memory!.buffer,
        pathPtr,
        pathLen,
      ).toString();
      const full = path.resolve(stats.path, p);
      const r = fs.readlinkSync(full);
      const used = Buffer.from(this.memory!.buffer).write(r, buf, bufLen);
      view.setUint32(bufused, used, true);
      return wc.WASI_ESUCCESS;
      */
  }

  private wasi_path_remove_directory(
    fd: number,
    pathPtr: number,
    pathLen: number,
  ) {
    this.logger.info(`wasi_path_remove_directory`, { fd, pathPtr, pathLen });
    const hdl = this.getFd(fd);
    return wc.WASI_ENOSYS;

    /*
      if (!stats.path) {
        return wc.WASI_EINVAL;
      }
      const view = new DataView(this.memory!.buffer);
      const p = Buffer.from(
        this.memory!.buffer,
        pathPtr,
        pathLen,
      ).toString();
      fs.rmdirSync(path.resolve(stats.path, p));
      return wc.WASI_ESUCCESS;
      */
  }

  private wasi_path_rename(
    oldFd: number,
    oldPath: number,
    oldPathLen: number,
    newFd: number,
    newPath: number,
    newPathLen: number,
  ) {
    this.logger.info(
      `wasi_path_rename`,
      { oldFd, oldPath, oldPathLen, newFd, newPath, newPathLen },
    );
    const ostats = this.getFd(oldFd);
    const nstats = this.getFd(newFd);
    return wc.WASI_ENOSYS;

    /*
      if (!ostats.path || !nstats.path) {
        return wc.WASI_EINVAL;
      }
      const view = new DataView(this.memory!.buffer);
      const op = Buffer.from(
        this.memory!.buffer,
        oldPath,
        oldPathLen,
      ).toString();
      const np = Buffer.from(
        this.memory!.buffer,
        newPath,
        newPathLen,
      ).toString();
      fs.renameSync(
        path.resolve(ostats.path, op),
        path.resolve(nstats.path, np),
      );
      return wc.WASI_ESUCCESS;
      */
  }

  private wasi_path_symlink(
    oldPath: number,
    oldPathLen: number,
    fd: number,
    newPath: number,
    newPathLen: number,
  ) {
    this.logger.info(
      `wasi_path_symlink`,
      { oldPath, oldPathLen, fd, newPath, newPathLen },
    );
    const hdl = this.getFd(fd);
    return wc.WASI_ENOSYS;

    /*
      if (!stats.path) {
        return wc.WASI_EINVAL;
      }
      const view = new DataView(this.memory!.buffer);
      const op = Buffer.from(
        this.memory!.buffer,
        oldPath,
        oldPathLen,
      ).toString();
      const np = Buffer.from(
        this.memory!.buffer,
        newPath,
        newPathLen,
      ).toString();
      fs.symlinkSync(op, path.resolve(stats.path, np));
      return wc.WASI_ESUCCESS;
      */
  }

  private wasi_path_unlink_file(fd: number, pathPtr: number, pathLen: number) {
    this.logger.info(`wasi_path_unlink_file`, { fd, pathPtr, pathLen });
    const hdl = this.getFd(fd);
    return wc.WASI_ENOSYS;

    /*
    if (!stats.path) {
      return wc.WASI_EINVAL;
    }
    const view = new DataView(this.memory!.buffer);
    const p = Buffer.from(this.memory!.buffer, pathPtr, pathLen).toString();
    fs.unlinkSync(path.resolve(stats.path, p));
    return wc.WASI_ESUCCESS;
    */
  }

  private wasi_poll_oneoff(
    sin: number,
    sout: number,
    nsubscriptions: number,
    nevents: number,
  ) {
    this.logger.info(
      `wasi_poll_oneoff`,
      { sin, sout, nsubscriptions, nevents },
    );

    const view = new DataView(this.memory!.buffer);
    for (let i = 0; i < nsubscriptions; i++) {
      const userData0 = view.getUint32(sin, true);
      sin += 4;
      const userData1 = view.getUint32(sin, true);
      sin += 4;
      const eventType = view.getUint8(sin);
      sin += 4;

      view.setUint32(sout, userData0, true);
      sout += 4;
      view.setUint32(sout, userData1, true);
      sout += 4;

      let err = 0;
      switch (eventType) {
        case wc.WASI_EVENTTYPE_CLOCK:
          break;
        case wc.WASI_EVENTTYPE_FD_READ: {
          const fd = view.getUint32(sin, true);
          const hdl = this.getFd(fd);
          const nBytesReady = hdl.fileGetSize() - hdl.fileOffset;
          this.logger.info('poll_fd_read', { fd, nBytesReady });
          view.setBigUint64(sout + 8, BigInt(nBytesReady), true);
          view.setUint16(sout + 16, nBytesReady ? 0 : 1, true);
          break;
        }
        case wc.WASI_EVENTTYPE_FD_WRITE:
          err = wc.WASI_ENOSYS;
          break;
      }

      sin += 36;

      view.setUint16(sout, err, true);
      sout += 2;
      view.setUint8(sout, eventType);
      sout += 22;
    }

    view.setUint32(nevents, nsubscriptions, true);
    return wc.WASI_ESUCCESS;

    /*
    let eventc = 0;
    let waitEnd = 0;
    const view = new DataView(this.memory!.buffer);
    for (let i = 0; i < nsubscriptions; i += 1) {
      const userdata = view.getBigUint64(sin, true);
      sin += 8;
      const type = view.getUint8(sin);
      sin += 1;
      switch (type) {
        case wc.WASI_EVENTTYPE_CLOCK: {
          sin += 7; // padding
          const identifier = view.getBigUint64(sin, true);
          sin += 8;
          const clockid = view.getUint32(sin, true);
          sin += 4;
          sin += 4; // padding
          const timestamp = view.getBigUint64(sin, true);
          sin += 8;
          const precision = view.getBigUint64(sin, true);
          sin += 8;
          const subclockflags = view.getUint16(sin, true);
          sin += 2;
          sin += 6; // padding

          const absolute = subclockflags === 1;

          let e = wc.WASI_ESUCCESS;
          const n = BigInt(now(clockid));
          if (n === null) {
            e = wc.WASI_EINVAL;
          } else {
            const end = absolute ? timestamp : n + timestamp;
            waitEnd = end > waitEnd ? (end as unknown as number) : waitEnd;
          }

          view.setBigUint64(sout, userdata, true);
          sout += 8;
          view.setUint16(sout, e, true); // error
          sout += 2; // pad offset 2
          view.setUint8(sout, wc.WASI_EVENTTYPE_CLOCK);
          sout += 1; // pad offset 3
          sout += 5; // padding to 8

          eventc += 1;

          break;
        }
        case wc.WASI_EVENTTYPE_FD_READ:
        case wc.WASI_EVENTTYPE_FD_WRITE: {
          sin += 3; // padding
          const fd = view.getUint32(sin, true);
          sin += 4;

          view.setBigUint64(sout, userdata, true);
          sout += 8;
          view.setUint16(sout, wc.WASI_ENOSYS, true); // error
          sout += 2; // pad offset 2
          view.setUint8(sout, type);
          sout += 1; // pad offset 3
          sout += 5; // padding to 8

          eventc += 1;

          break;
        }
        default:
          return wc.WASI_EINVAL;
      }
    }

    view.setUint32(nevents, eventc, true);

    while (bindings.hrtime() < waitEnd) {
      // nothing
    }

    return wc.WASI_ESUCCESS;
    */
  }

  private wasi_proc_exit(rval: number) {
    this.logger.info(`wasi_proc_exit`, { rval });
    throw new WasiExit(rval);
  }

  private wasi_proc_raise(sig: number) {
    this.logger.info(`wasi_proc_raise`, { sig });
    return wc.WASI_ENOSYS;

    /*
    if (!(sig in SIGNAL_MAP)) {
      return wc.WASI_EINVAL;
    }
    bindings.kill(SIGNAL_MAP[sig]);
    return wc.WASI_ESUCCESS;
    */
  }

  private wasi_random_get(bufPtr: number, bufLen: number) {
    this.logger.info(`wasi_random_get`, { bufPtr, bufLen });
    if (enableRandom) {
      crypto.getRandomValues(
        new Uint8Array(this.memory!.buffer, bufPtr, bufLen),
      );
      return wc.WASI_ESUCCESS;
    } else {
      return wc.WASI_ENOSYS;
    }
  }

  private wasi_sched_yield() {
    this.logger.info(`wasi_sched_yield`, {});
    return wc.WASI_ESUCCESS;
  }

  private wasi_sock_recv() {
    this.logger.info(`wasi_sock_recv`, {});
    return wc.WASI_ENOSYS;
  }

  private wasi_sock_send() {
    this.logger.info(`wasi_sock_send`, {});
    return wc.WASI_ENOSYS;
  }

  private wasi_sock_shutdown() {
    this.logger.info(`wasi_sock_shutdown`, {});
    return wc.WASI_ENOSYS;
  }

  /*
private stat(fd: number): File {
const entry = this.FD_MAP.get(fd);
if (!entry) {
  throwWasiErr(wc.WASI_EBADF);
}
if (entry.filetype === undefined) {
  const stats = this.bindings.fs.fstatSync(entry.real);
  const { filetype, rightsBase, rightsInheriting } =
    this.translateFileAttributes(wasi, fd, stats);
  entry.filetype = filetype as wc.WASI_FILETYPE;
  if (!entry.rights) {
    entry.rights = {
      base: rightsBase,
      inheriting: rightsInheriting,
    };
  }
}
return entry;
}

private translateFileAttributes(fd: number | undefined, stats: any) {
switch (true) {
  case stats.isBlockDevice():
    return {
      filetype: wc.WASI_FILETYPE_BLOCK_DEVICE,
      rightsBase: RIGHTS_BLOCK_DEVICE_BASE,
      rightsInheriting: RIGHTS_BLOCK_DEVICE_INHERITING,
    };
  case stats.isCharacterDevice(): {
    const filetype = wc.WASI_FILETYPE_CHARACTER_DEVICE;
    if (fd !== undefined && this.bindings.isTTY(fd)) {
      return {
        filetype,
        rightsBase: RIGHTS_TTY_BASE,
        rightsInheriting: RIGHTS_TTY_INHERITING,
      };
    }
    return {
      filetype,
      rightsBase: RIGHTS_CHARACTER_DEVICE_BASE,
      rightsInheriting: RIGHTS_CHARACTER_DEVICE_INHERITING,
    };
  }
  case stats.isDirectory():
    return {
      filetype: wc.WASI_FILETYPE_DIRECTORY,
      rightsBase: RIGHTS_DIRECTORY_BASE,
      rightsInheriting: RIGHTS_DIRECTORY_INHERITING,
    };
  case stats.isFIFO():
    return {
      filetype: wc.WASI_FILETYPE_SOCKET_STREAM,
      rightsBase: RIGHTS_SOCKET_BASE,
      rightsInheriting: RIGHTS_SOCKET_INHERITING,
    };
  case stats.isFile():
    return {
      filetype: wc.WASI_FILETYPE_REGULAR_FILE,
      rightsBase: RIGHTS_REGULAR_FILE_BASE,
      rightsInheriting: RIGHTS_REGULAR_FILE_INHERITING,
    };
  case stats.isSocket():
    return {
      filetype: wc.WASI_FILETYPE_SOCKET_STREAM,
      rightsBase: RIGHTS_SOCKET_BASE,
      rightsInheriting: RIGHTS_SOCKET_INHERITING,
    };
  case stats.isSymbolicLink():
    return {
      filetype: wc.WASI_FILETYPE_SYMBOLIC_LINK,
      rightsBase: 0n,
      rightsInheriting: 0n,
    };
  default:
    return {
      filetype: wc.WASI_FILETYPE_UNKNOWN,
      rightsBase: 0n,
      rightsInheriting: 0n,
    };
  }
}
  */
}
