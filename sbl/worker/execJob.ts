import { error } from '~/sbl/util/functional.ts';
import { WorkerChannelClient } from './WorkerChannel.ts';
import { JobMessage, WorkerComm } from './workerTypes.ts';
import Hash from '~/sbl/util/Hash.ts';
import { makeClientUtils } from '~/sbl/worker/clientUtils.ts';
import { makeWasiImports } from '~/sbl/worker/jsWasiUtils.ts';
import { jsWasiHash, rootHash } from '~/sbl/constants.ts';
import logger from '~/sbl/worker/logger.ts';
import { WasiExit } from '~/sbl/worker/WasiImpl.ts';

export interface BaseImports extends WebAssembly.Imports {
  env: { memory: WebAssembly.Memory };
  scaffold: {
    writeContractHash(dst: number): void;
    getParamSize(): number;
    writeParams(dst: number): void;
    emitCorrect(): number;

    setBody(ptr: number, size: number): void;

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

  const memory = new WebAssembly.Memory({
    // initial: 10, // Each page is 64KiB
    initial: 1 << 12, // Each page is 64KiB
    maximum: 1 << 12, // Each page is 64KiB
    shared: true,
  });

  const baseImports: BaseImports = {
    env: { memory },
    scaffold: {
      writeContractHash: (dst: number) =>
        new Uint8Array(memory.buffer, dst).set(job.contractHash),
      getParamSize: () => job.params.byteLength,
      writeParams: (dst: number) =>
        new Uint8Array(memory.buffer, dst).set(job.params),
      emitCorrect: () => job.emitCorrect ? 1 : 0,

      setBody: (ptr, size) =>
        clientUtils.returnResult(new Uint8Array(memory.buffer, ptr, size)),

      exit: () => error(`Unimplemented`),
    },
  };

  const runQueue: CallableFunction[] = [];

  const instantiate = async (code: Uint8Array) => {
    // TODO: Cache this step?
    const mod = await WebAssembly.compile(code);

    const imports = await getImports(mod);
    const instance = await WebAssembly.instantiate(mod, imports);

    if (instance.exports.memory instanceof WebAssembly.Memory) {
      throw new Error('WASM modules must import their memory!');
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
      return makeWasiImports(client, wrapperParams, job, baseImports);
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
      env: { memory },
      scaffold: {
        getParamSize: () => wrapperParams.byteLength,
        writeParams: (dst: number) =>
          new Uint8Array(memory.buffer, dst).set(wrapperParams),
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
  // TODO: Cache

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

  // To continue using the current WASM instance, simply wrap with an additional WASM.
  // This involves caching the result of `await instantiate(job.code);` and reusing it if it's requested as a wrapper.
};
