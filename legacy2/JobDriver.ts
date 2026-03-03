import {
  DataTreeNode,
  ImmutableTreeNode,
  MutableDataTreeNode,
  MutableTreeNode,
  TreeNode,
} from './DataTreeOverlay.ts';
import { BurdenOfProof, ComputationDriver } from './ComputationMeta.ts';
import { LogLevel } from './Logger.ts';
import { error } from './util/functional.ts';
import { FsName, RunnerComm, WorkerComm } from './worker/workerTypes.ts';
import { Job } from './WorkerManager.ts';
import { encodeDataTree } from './DataTreeHelper.ts';
import { rootHash, trueHash } from './hashes.ts';
import { assert } from '@std/assert/assert';
import { DataTree } from './protocol/base.ts';

export class JobDriver implements WorkerComm {
  private handles = new Map<number, ImmutableTreeNode | MutableTreeNode>();
  private pongHandler?: () => void;

  constructor(
    private runner: RunnerComm,
    private instanceId: number,
    private driver: ComputationDriver,
    private getResult: () => DataTree,
  ) {}

  public async run(job: Job): Promise<DataTree> {
    this.runner.postMessage({
      type: 'instantiate_wasm',
      instanceId: this.instanceId,
      module: job.wasmModule,
    });

    for (const method of job.calls) {
      this.runner.postMessage({ type: 'call_method', instanceId: this.instanceId, method });
    }

    this.runner.postMessage({ type: 'ping', instanceId: this.instanceId });

    await new Promise<void>((resolve) => {
      assert(this.pongHandler === undefined);
      this.pongHandler = resolve;
    });

    return this.getResult();
  }

  ready(): undefined {
    throw new Error('Method not implemented.');
  }

  exit(err?: any): undefined {
    throw new Error('Method not implemented.');
  }

  init(name: FsName, hdl: number): undefined {
    let node: ImmutableTreeNode | MutableTreeNode;

    switch (name) {
      case FsName.ContractHash:
        node = new DataTreeNode(encodeDataTree(this.driver.contractHash));
        break;
      case FsName.Params:
        node = this.driver.params;
        break;
      case FsName.Hint:
        node = this.driver.getHint(0, BurdenOfProof.Invalidation);
        break;
      case FsName.Body:
        node = this.driver.body;
        break;
      case FsName.EmitCorrect:
        node = new DataTreeNode(encodeDataTree(this.driver.emitCorrect()));
        break;
      case FsName.Ext:
        node = this.driver.fetch(trueHash, encodeDataTree({}));
        break;
      case FsName.Output:
        node = new MutableDataTreeNode();
        break;
      case FsName.Log:
        node = new MutableDataTreeNode();
        break;
    }

    this.handles.set(hdl, node);
  }

  open(parentHdl: number, childHdl: number, key: Uint8Array): undefined {
    const parent = this.handles.get(parentHdl) ?? error(`Invalid handle ${parentHdl}`);
    this.handles.set(childHdl, parent.open(key));
  }

  async size(hdl: number): Promise<number> {
    const node = this.handles.get(hdl) ?? error(`Invalid handle ${hdl}`);
    return (await node.size()) ?? -1;
  }

  async read(hdl: number, offset: number, dstBufs: Uint8Array[]): Promise<number> {
    const node = this.handles.get(hdl) ?? error(`Invalid handle ${hdl}`);
    let written = 0;
    for (const buf of dstBufs) {
      const amt = await node.read(buf, offset + written);
      if (amt === undefined) {
        return -1;
      }
      written += buf.byteLength;
    }
    return written;
  }

  write(hdl: number, offset: number, srcBufs: Uint8Array[]): undefined {
    const node = this.handles.get(hdl) ?? error(`Invalid handle ${hdl}`);
    if (!node.isMutable) {
      throw new Error(`Cannot write a read-only fs node!`);
    }
    for (const buf of srcBufs) {
      node.write(buf, offset);
      offset += buf.byteLength;
    }
  }

  pong(): undefined {
    const handler = this.pongHandler;
    assert(handler !== undefined);

    this.pongHandler = undefined;
    handler();
  }

  log(level: LogLevel, message: string, data: { [key: string]: unknown }): undefined {
    throw new Error('Method not implemented.');
  }

  debugLog(msg: Uint8Array): undefined {
    throw new Error('Method not implemented.');
  }

  debugPtr(name: Uint8Array, mem: Uint8Array, ptr: number): undefined {
    throw new Error('Method not implemented.');
  }

  debugBreak(): Promise<void> {
    throw new Error('Method not implemented.');
  }
}

/*

  const instantiate = async (code: Uint8Array) => {
    // TODO: Cache this step?
    const mod = await WebAssembly.compile(code);
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
          writeParams: (dst: number) => new Uint8Array(memory!.buffer, dst).set(wrapperParams),
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



      const entryFuncs = WebAssembly.Module.customSections(
        mod,
        'scaffold_v0_entry_funcs',
      );
      entryFuncs.forEach((buf) => {
        const name = new TextDecoder().decode(buf);
        runQueue.push(instance.exports[name] as CallableFunction);
      });


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
*/
