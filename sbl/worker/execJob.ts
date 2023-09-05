import { error } from '~/sbl/util/functional.ts';
import { WorkerChannelClient } from './WorkerChannel.ts';
import { JobMessage, WorkerComm } from './workerTypes.ts';
import Hash from '~/sbl/util/Hash.ts';
import { makeClientUtils } from '~/sbl/worker/clientUtils.ts';
import { makeWasiImports } from '~/sbl/worker/jsWasiUtils.ts';
import { jsWasiHash } from '~/sbl/constants.ts';

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

  const runQueue: CallableFunction[] = [];

  const instantiate = async (job: JobMessage) => {
    // TODO: Cache this step?
    const mod = await WebAssembly.compile(job.code);

    const imports = await getImports(mod, job);
    const instance = await WebAssembly.instantiate(mod, imports);

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

  const makeBaseImports = (job: JobMessage): WebAssembly.Imports => ({
    env: { memory },
    scaffold: {
      getParamSize: () => job.params.byteLength,
      writeParams: (dst: number) =>
        new Uint8Array(memory.buffer, dst).set(job.params),
      call: () => error(`Unimplemented`),
      exit: () => error(`Unimplemented`),
    },
  });

  const getImports = async (mod: WebAssembly.Module, job: JobMessage) => {
    const wrapperHashBytes = getCustomSection(mod, 'scaffold_v0_wrapper_hash');
    if (wrapperHashBytes === undefined) {
      return makeBaseImports(job);
    }

    const wrapperHash = Hash.fromBytes(wrapperHashBytes);
    const wrapperParams = getCustomSection(mod, 'scaffold_v0_wrapper_params') ??
      new Uint8Array();

    if (Hash.equals(wrapperHash, jsWasiHash)) {
      const imports = makeBaseImports(job);
      const wasiImports = makeWasiImports(client, memory, wrapperParams, job);
      imports.wasi_snapshot_preview1 = wasiImports;
      imports.wasi_unstable = wasiImports;
      return imports;
    }

    const wrapperCode = clientUtils.request(wrapperHash, wrapperParams);

    const {
      mod: wrapperMod,
      instance: wrapperInstance,
    } = await instantiate({
      code: wrapperCode,
      contractHash: wrapperHashBytes,
      params: wrapperParams,
      emitCorrect: true,
    });

    const linkExports = WebAssembly.Module.customSections(
      wrapperMod,
      'scaffold_v0_link_exports',
    );

    const imports = makeBaseImports(job);
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

  await instantiate(job);

  runQueue.forEach((fn) => fn());
};
