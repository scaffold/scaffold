import { error } from '~/sbl/util/functional.ts';
import { WorkerChannelClient } from './WorkerChannel.ts';
import { JobMessage, WorkerComm } from './workerTypes.ts';
import Hash from '~/sbl/util/Hash.ts';
import { makeClientUtils } from '~/sbl/worker/clientUtils.ts';
import { makeWasi } from '~/sbl/worker/jsWasiUtils.ts';
import { jsLockHash, jsWasiHash, rootHash } from '~/sbl/constants.ts';
import logger from '~/sbl/worker/logger.ts';
import { WasiExit } from '~/sbl/worker/WasiImpl.ts';
import { JsWasiParams } from '~/sbl/messages.ts';
// import binaryen from 'binaryen';

export interface BaseImports extends WebAssembly.Imports {
  scaffold: {
    readContractHash(dstPtr: number, dstSize: number, offset: number): number;
    readParams(dstPtr: number, dstSize: number, offset: number): number;
    readHint(dstPtr: number, dstSize: number, offset: number): number;
    readBody(dstPtr: number, dstSize: number, offset: number): number;

    emitCorrect(): number;

    requireBody(ptr: number, size: number): void;

    exit(): void;
  };
}

const getCustomSection = (mod: WebAssembly.Module, key: string) => {
  // https://github.com/xtuc/wasm-custom-section
  // https://wapm.io/liftm/wasm-custom-section
  const sections = WebAssembly.Module.customSections(mod, key);
  if (sections.length > 0) {
    if (sections.length > 1) {
      throw new Error(`More than one custom section with key ${key}!`);
    }
    return new Uint8Array(sections[0]);
  }
};

export default async (
  client: WorkerChannelClient<WorkerComm>,
  job: JobMessage,
) => {
  const clientUtils = makeClientUtils(client);

  let memory: WebAssembly.Memory | undefined;

  // const __liftString = (pointer: number) => {
  //   if (!pointer) return null;
  //   const end = pointer + new Uint32Array(memory!.buffer)[pointer - 4 >>> 2] >>>
  //       1,
  //     memoryU16 = new Uint16Array(memory!.buffer);
  //   let start = pointer >>> 1,
  //     string = '';
  //   while (end - start > 1024) {
  //     string += String.fromCharCode(
  //       ...memoryU16.subarray(start, start += 1024),
  //     );
  //   }
  //   return string + String.fromCharCode(...memoryU16.subarray(start, end));
  // };

  const baseImports: BaseImports = {
    env: {
      // abort(
      //   message: number,
      //   fileName: number,
      //   lineNumber: number,
      //   columnNumber: number,
      // ) {
      //   const msgStr = __liftString(message >>> 0);
      //   const fileStr = __liftString(fileName >>> 0);
      //   lineNumber = lineNumber >>> 0;
      //   columnNumber = columnNumber >>> 0;
      //   (() => {
      //     // @external.js
      //     throw Error(`${msgStr} in ${fileStr}:${lineNumber}:${columnNumber}`);
      //   })();
      // },
    },

    scaffold: {
      readContractHash: (dstPtr, dstSize, offset) =>
        client.dispatch('readContractHash', [
          new Uint8Array(memory!.buffer, dstPtr, dstSize),
          offset,
        ], []),
      readParams: (dstPtr, dstSize, offset) =>
        client.dispatch('readParams', [
          new Uint8Array(memory!.buffer, dstPtr, dstSize),
          offset,
        ], []),
      readHint: (dstPtr, dstSize, offset) =>
        client.dispatch('readHint', [
          new Uint8Array(memory!.buffer, dstPtr, dstSize),
          offset,
        ], []),
      readBody: (dstPtr, dstSize, offset) =>
        client.dispatch('readBody', [
          new Uint8Array(memory!.buffer, dstPtr, dstSize),
          offset,
        ], []),

      emitCorrect: () => client.dispatch('emitCorrect', [], []),

      requireBody: (ptr, size) =>
        client.inform('requireBody', [
          new Uint8Array(memory!.buffer, ptr, size),
        ], []),

      exit: () => error(`Unimplemented`),
    },
    // binaryen: Object.fromEntries(
    //   Object.entries(binaryen).filter(([key, val]) => key[0] === '_'),
    // ) as any,
  };

  const runQueue: CallableFunction[] = [];
  const cleanupQueue: CallableFunction[] = [];

  const instantiate = async (code: Uint8Array) => {
    // TODO: Cache this step?
    const mod = await WebAssembly.compile(code);

    const imports = await getImports(mod);

    if (imports.env === undefined) {
      imports.env = {};
    }

    const willExportMemory = WebAssembly.Module.exports(mod)
      .some((exp) => exp.name === 'memory' && exp.kind === 'memory');
    if (!willExportMemory) {
      if (memory === undefined) {
        memory = new WebAssembly.Memory({
          // initial: 10, // Each page is 64KiB
          initial: 1 << 12, // Each page is 64KiB
          maximum: 1 << 12, // Each page is 64KiB
          shared: true,
        });
      }
      imports.env.memory = memory;
    }

    const instance = await WebAssembly.instantiate(mod, imports);

    if (instance.exports.memory instanceof WebAssembly.Memory) {
      if (!(instance.exports.memory.buffer instanceof SharedArrayBuffer)) {
        // throw new Error(`Exported memory is not shared!`);
        console.warn(
          `Exported memory is not shared! This may or may not be a problem...`,
        );
      }
      if (memory !== undefined) {
        throw new Error(`Cannot export multiple memories!`);
      }
      memory = instance.exports.memory;
    }

    const entryFuncs = WebAssembly.Module.customSections(
      mod,
      'scaffold_v0_entry_funcs',
    );
    entryFuncs.forEach((buf) => {
      const name = new TextDecoder().decode(buf);
      runQueue.push(instance.exports[name] as CallableFunction);
    });

    return { mod, instance };
  };

  const getImports = async (
    mod: WebAssembly.Module,
  ): Promise<WebAssembly.Imports> => {
    const wrapperHashBytes = getCustomSection(mod, 'scaffold_v0_wrapper_hash');
    if (wrapperHashBytes === undefined) {
      return baseImports;
    }

    const wrapperHash = Hash.fromBytes(wrapperHashBytes);
    const wrapperParams = getCustomSection(mod, 'scaffold_v0_wrapper_params') ??
      new Uint8Array();

    if (Hash.equals(wrapperHash, jsWasiHash)) {
      const wasiParams = JsWasiParams.decode(wrapperParams);
      const wasi = makeWasi(client, wasiParams, job, baseImports);

      runQueue.push(() => wasi.setMemory(memory!));

      const wasiImports = wasi.getImports();
      return { wasi_snapshot_preview1: wasiImports };
    } else if (Hash.equals(wrapperHash, jsLockHash)) {
      throw new Error(`Not implemented yet`);
      // const lockWrapperParams=LockWrapperParams.decode(wrapperParams);
      // const wasi =
      // const wrapper = makeLockWrapper(client, wrapperParams, job, baseImports, wasi);

      // cleanupQueue.push(() => wrapper.cleanup());

      // return wrapper.imports;
    }

    const wrapperCode = clientUtils.request(rootHash, wrapperHash.toBytes());

    const {
      mod: wrapperMod,
      instance: wrapperInstance,
    } = await instantiate(wrapperCode);

    const linkExports = WebAssembly.Module.customSections(
      wrapperMod,
      'scaffold_v0_link_exports',
    );

    const imports: WebAssembly.Imports = {
      scaffold: {
        getParamSize: () => wrapperParams.byteLength,
        writeParams: (dst: number) =>
          new Uint8Array(memory!.buffer, dst).set(wrapperParams),
      },
    };
    for (const buf of linkExports) {
      const path = new TextDecoder().decode(buf);
      const entries = path.split('.');
      if (entries.length !== 2) {
        throw new Error(`Must have exactly one dot for path ${path}!`);
      }
      imports[entries[0]][entries[1]] = wrapperInstance.exports[entries[1]];
    }
    return imports;
  };

  const out = await instantiate(job.code);
  // TODO: Cache if it's used as a wrapper

  if (memory === undefined) {
    throw new Error(`No memory exported or imported!`);
  }

  runQueue.forEach((fn) => {
    logger.info('Running...', {});
    try {
      fn();
    } catch (err) {
      if (err instanceof WasiExit) {
        // If it's a normal WASI exit, we return it directly
        if (err.code !== 0) {
          logger.warning(
            `Ended with code ${err.code}`,
            { err, code: err.code },
          );
        }
      } else {
        // Otherwise we let the error bubble up
        logger.error(`Ended with unhandlable error`, { err });
        throw err;
      }
    }

    logger.info('Ended successfully', {});
  });

  cleanupQueue.toReversed().forEach((fn) => fn());

  // To continue using the current WASM instance, simply wrap with an additional WASM.
  // This involves caching the result of `await instantiate(job.code);` and reusing it if it's requested as a wrapper.
};
