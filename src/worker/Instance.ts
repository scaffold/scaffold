import { WorkerChannel } from './WorkerChannel.ts';
import { CallMethodMsg, FsName, InstantiateWasmMsg, WorkerComm } from './workerTypes.ts';
import { error } from '../util/functional.ts';
import { Hash } from '../util/Hash.ts';
import { makeWasi } from './jsWasiUtils.ts';
import { jsLockHash, jsWasiHash, rootHash } from '../hashes.ts';
import { WasiExit } from './WasiImpl.ts';
import { JsWasiParams } from '../messages.ts';
import { assert } from '@std/assert/assert';
// import { binaryen } from 'binaryen';

interface BaseImports extends WebAssembly.Imports {
  scaffold: {
    /*
    This filesystem-like model make a number of simplifying assumptions.
    open() always succeeds. Directories do not need to be created.
    There's no difference between a directory and a file - a node can both have contents and have children.
    */

    init(name: FsName): number; // Returns the root hdl
    open(hdl: number, keyPtr: number, keySize: number): number; // Returns the child hdl

    size(hdl: number): number; // Returns the total size
    read(hdl: number, offset: number, dstPtr: number, dstSize: number): number; // Returns the size read
    readIoVecs(hdl: number, offset: number, iovsPtr: number, iovsLen: number): number; // Returns the size read

    write(hdl: number, offset: number, srcPtr: number, srcSize: number): number; // Returns the written size
  };
}

export class Instance {
  private nextHdl = 0;
  private memory?: WebAssembly.Memory;
  private instance?: WebAssembly.Instance;

  constructor(private channel: WorkerChannel<WorkerComm>) {
  }

  async instantiate(msg: InstantiateWasmMsg) {
    assert(this.instance === undefined);

    const imports = await this.getImports(msg.module);

    if (imports.env === undefined) {
      imports.env = {};
    }

    const willExportMemory = WebAssembly.Module.exports(msg.module)
      .some((exp) => exp.name === 'memory' && exp.kind === 'memory');
    if (!willExportMemory) {
      if (this.memory === undefined) {
        this.memory = new WebAssembly.Memory({
          // initial: 10, // Each page is 64KiB
          initial: 1 << 12, // Each page is 64KiB
          maximum: 1 << 12, // Each page is 64KiB
          shared: true,
        });
      }
      imports.env.memory = this.memory;
    }

    this.instance = await WebAssembly.instantiate(msg.module, imports);

    if (this.instance.exports.memory instanceof WebAssembly.Memory) {
      if (!(this.instance.exports.memory.buffer instanceof SharedArrayBuffer)) {
        // throw new Error(`Exported memory is not shared!`);
        console.warn(
          `Exported memory is not shared! This may or may not be a problem...`,
        );
      }
      if (this.memory !== undefined) {
        throw new Error(`Cannot export multiple memories!`);
      }
      this.memory = this.instance.exports.memory;
    }

    // if (
    //   msg.readMetas &&
    //   'SCAFFOLD_PARAMS_JSON_SCHEMA_PTR' in instance.exports &&
    //   'SCAFFOLD_PARAMS_JSON_SCHEMA_LEN' in instance.exports
    // ) {
    //   client.inform('paramsJsonSchema', [
    //     new Uint8Array(
    //       memory!.buffer,
    //       instance.exports.SCAFFOLD_PARAMS_JSON_SCHEMA_PTR as unknown as number,
    //       instance.exports.SCAFFOLD_PARAMS_JSON_SCHEMA_LEN as unknown as number,
    //     ),
    //   ], []);
    // }
  }

  call(msg: CallMethodMsg) {
    assert(this.instance !== undefined);

    const fn = this.instance.exports[msg.method] as CallableFunction;
    try {
      fn();
    } catch (err) {
      if (err instanceof WasiExit) {
        // If it's a normal WASI exit, we return it directly
        if (err.code !== 0) {
          console.warn(`Ended with code ${err.code}`, { err, code: err.code });
        }
      } else {
        // Otherwise we let the error bubble up
        throw err;
      }
    }
  }

  private getImports(module: WebAssembly.Module) {
    return Promise.resolve(this.makeBaseImports());
  }

  private makeBaseImports(): BaseImports {
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

    return {
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
        init: (name) => {
          this.channel.inform('init', [name, this.nextHdl], []);
          return this.nextHdl++;
        },

        open: (hdl, keyPtr, keySize) => {
          this.channel.inform('open', [
            hdl,
            this.nextHdl,
            new Uint8Array(this.memory!.buffer, keyPtr, keySize),
          ], []);
          return this.nextHdl++;
        },

        size: (hdl) => this.channel.dispatch('size', [hdl], []),

        read: (hdl, offset, dstPtr, dstSize) =>
          this.channel.dispatch('read', [hdl, offset, [
            new Uint8Array(this.memory!.buffer, dstPtr, dstSize),
          ]], []),

        readIoVecs: (hdl, offset, iovsPtr, iovsLen) =>
          this.channel.dispatch('read', [hdl, offset, this.getIovs(iovsPtr, iovsLen)], []),

        write: (hdl, offset, srcPtr, srcSize) => {
          this.channel.inform('write', [hdl, offset, [
            new Uint8Array(this.memory!.buffer, srcPtr, srcSize),
          ]], []);
          return srcSize;
        },
      },
      // binaryen: Object.fromEntries(
      //   Object.entries(binaryen).filter(([key, val]) => key[0] === '_'),
      // ) as any,
    };
  }

  private getIovs(iovs: number, iovsLen: number) {
    if (iovs + iovsLen * 8 > this.memory!.buffer.byteLength) {
      throw new Error(
        `Trying to read up to ${iovs} but memory is only ${this.memory!.buffer.byteLength} bytes`,
      );
    }

    const view = new DataView(this.memory!.buffer);

    return Array.from({ length: iovsLen }, (_, i) => {
      const offset = view.getUint32(iovs, true);
      iovs += 4;
      const size = view.getUint32(iovs, true);
      iovs += 4;
      return new Uint8Array(this.memory!.buffer, offset, size);
    });
  }
}
