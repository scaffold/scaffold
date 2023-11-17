import Context from './Context.ts';
import { formatPath } from './worker/pathUtils.ts';
import { WorkerChannelServer } from './worker/WorkerChannel.ts';
import {
  InitialMessage,
  JobMessage,
  WorkerComm,
} from './worker/workerTypes.ts';
import Hash from './util/Hash.ts';
import { Block, Verifier } from './messages.ts';
import { rootHash } from './constants.ts';
import { error } from './util/functional.ts';
import WorkerDebuggerManager, {
  WorkerDebugger,
} from './WorkerDebuggerManager.ts';
import { ComputationDriver } from './WorkerLauncherService.ts';
import { MaybePromise } from '~/sbl/util/types.ts';

interface OpenFile {
  // TODO: Remove these, just used for debugging
  path: Uint8Array[];

  verifier: Promise<Verifier>;
  body?: Promise<Uint8Array>;

  // question: Question;
  // readerStream: Promise<IncentivizedStream<Uint8Array>>;
  // exposedData?: Promise<Uint8Array>;
}

const writeBuf = (dstBuf: Uint8Array, src: Uint8Array, offset: number) => {
  dstBuf.set(src.subarray(offset, offset + dstBuf.byteLength));
  return src.byteLength;
};
const writeIovs = (dstBufs: Uint8Array[], src: Uint8Array, offset: number) => {
  let it = offset;
  for (const buf of dstBufs) {
    const limit = Math.min(it + buf.length, src.length);
    buf.set(src.subarray(it, limit));
    it = limit;
    if (it === src.length) {
      break;
    }
  }
  return it - offset;
};

export default class WorkerExecutor {
  constructor(private ctx: Context) {}

  public run(job: JobMessage, driver: ComputationDriver): MaybePromise<void> {
    if (driver.done.signal.aborted) {
      return;
    }

    const worker = new Worker(
      typeof Deno !== 'undefined'
        ? new URL('./worker/worker.ts', import.meta.url).href // Deno
        : new URL('./worker.js', window.location.href).href, // Browser
      {
        type: 'module',
        // deno: {
        //   namespace: false,
        //   permissions: {
        //     env: false,
        //     hrtime: false,
        //     net: false,
        //     ffi: false,
        //     read: false,
        //     run: false,
        //     write: false,
        //   },
        // },
      },
    );

    const sigBuf = new SharedArrayBuffer(8);
    const msg: InitialMessage = { sigBuf };
    worker.postMessage(msg);

    // TODO: If we're waiting in Atomic.wait, we can wake the worker up and make it throw an exception.
    // This way we won't have to re-start the worker.
    // If the worker's just spinning in WASM, we have no alternative other than just terminating it.
    // To kill worker, wait 1 second until it blocks and throw, or else terminate.

    const terminateFn = (_err?: unknown) => worker.terminate();
    let cancelCb = terminateFn;
    driver.done.signal.addEventListener('abort', () => cancelCb());

    let codeHash: Hash | undefined;
    const getDebugger = (): WorkerDebugger => {
      codeHash ??= Hash.digest(job.code);
      const dbgr = this.ctx.get(WorkerDebuggerManager).getDebugger(codeHash);
      if (dbgr === undefined) {
        console.error(
          `No debugger configured for code hash ${codeHash.toHex()}`,
        );
        throw new Error(
          `No debugger configured for code hash ${codeHash.toHex()}`,
        );
      }
      return dbgr;
    };

    const inodes = new Map<number, OpenFile>();
    const outputs: Record<string, { size: number; chunks: Uint8Array[] }> = {};

    let exitResolver: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      exitResolver = resolve;
    });

    let sentJob = false;

    const getBody = (file: OpenFile) => {
      if (file.body === undefined) {
        file.body = file.verifier.then((verifier) =>
          new Promise((resolve, reject) => {
            if (cancelCb !== terminateFn) throw new Error('Internal error');
            cancelCb = reject;
            driver.request(verifier.contract_hash, verifier.params).then(
              (body) => {
                if (cancelCb !== reject) throw new Error('Internal error');
                cancelCb = terminateFn;
                resolve(body);
              },
            );
          })
        );
      }
      return file.body;
    };

    const getBodyHash = (file: OpenFile) =>
      file.verifier.then(({ contract_hash, params }) =>
        Hash.equals(contract_hash, rootHash)
          ? Hash.fromBytes(params)
          : getBody(file).then(Hash.digest)
      );

    new WorkerChannelServer<WorkerComm>(worker, sigBuf, {
      ready(): undefined {
        if (!sentJob) {
          // TODO: Use this when we switch from wasi to pure-wasm
          // ctx.get(FetchService).fetch(
          //   codeVerifier,
          //   { externalIncentive: 1n },
          //   ({ body }) => {
          //     const msg: JobMessage = { code: body, inputs, outputSpec };
          //     worker.postMessage(msg, {
          //       // transfer: Object.values(inputs).map((buf) =>
          //       //   (buf as Uint8Array).buffer
          //       // ),
          //     });
          //   },
          // );

          worker.postMessage(job);

          // Only send one job, then end worker.
          worker.postMessage(undefined);

          sentJob = true;
        }
        return undefined;
      },
      exit(err): undefined {
        if (err !== undefined) {
          console.error(err);
        }

        // Hacky solution to pass/fail based on output; eventually WASM should call our driver methods directly
        const outputBufs = Object.fromEntries(
          Object.entries(outputs).map(([key, { size, chunks }]) => {
            const buf = new Uint8Array(size);
            chunks.reduce((offset, chunk) => {
              buf.set(chunk, offset);
              return offset + chunk.length;
            }, 0);
            return [key, buf];
          }),
        );
        console.log('Outputs:', outputBufs);
        if ('stdout' in outputBufs) {
          driver.requireBody(outputBufs.stdout);
        }
        if ('fail' in outputBufs) {
          driver.fail();
        }

        exitResolver();
      },

      // Each of these returns the TOTAL size of the source buffer; irrespective of the dstBuf size or offset.

      // We need async here to catch errors
      // deno-lint-ignore require-await
      async readContractHash(
        dstBuf: Uint8Array,
        offset: number,
      ): Promise<number> {
        return writeBuf(dstBuf, driver.getContractHash().toBytes(), offset);
      },
      // deno-lint-ignore require-await
      async readParams(dstBuf: Uint8Array, offset: number): Promise<number> {
        return writeBuf(dstBuf, driver.getParams(), offset);
      },
      // deno-lint-ignore require-await
      async readHint(dstBuf: Uint8Array, offset: number): Promise<number> {
        return writeBuf(dstBuf, driver.getHint(), offset);
      },
      // deno-lint-ignore require-await
      async readBody(dstBuf: Uint8Array, offset: number): Promise<number> {
        return writeBuf(dstBuf, driver.getBody(), offset);
      },
      // deno-lint-ignore require-await
      async emitCorrect(): Promise<number> {
        return driver.emitCorrect() ? 1 : 0;
      },

      requireBody(body: Uint8Array): undefined {
        driver.requireBody(body);
      },

      init(type: string, inode: number): undefined {
        const hash = { ext: rootHash }[type] ||
          error('Invalid init inode type');
        inodes.set(inode, {
          path: [],
          verifier: Promise.resolve({
            contract_hash: rootHash,
            params: hash.toBytes(),
          }),
        });
      },

      open(
        baseInode: number,
        params: Uint8Array,
        amount: bigint,
        subInode: number,
      ): undefined {
        const path = [...inodes.get(baseInode)!.path, params];
        console.log(`Preopen ${formatPath(path)}`);

        const baseFile = inodes.get(baseInode)!;
        inodes.set(subInode, {
          path,
          verifier: getBodyHash(baseFile).then((contractHash) => {
            driver.notify(contractHash, params);
            return { contract_hash: contractHash, params };
          }),
        });
      },

      async getSize(inode: number): Promise<number> {
        // The ONLY awaits in this function should be for getBody, since it handles cancels
        const body = await getBody(inodes.get(inode)!);
        return body.byteLength;
      },

      async read(
        inode: number,
        dstBufs: Uint8Array[],
        offset: number,
      ): Promise<number> {
        // The ONLY awaits in this function should be for getBody, since it handles cancels
        const body = await getBody(inodes.get(inode)!);
        return writeIovs(dstBufs, body, offset);
      },

      outputChunk(key: string, offset: number, data: Uint8Array): undefined {
        if (outputs[key] === undefined) {
          outputs[key] = { size: 0, chunks: [] };
        }
        const output = outputs[key];

        if (offset !== output.size) {
          throw new Error(
            `Unexpected offset (${offset} !== ${output.size}), messages must be unordered`,
          );
        }

        output.size += data.length;
        output.chunks.push(data);

        return undefined;
      },
      // notify(contractHash: Uint8Array, params: Uint8Array): undefined {
      //   return undefined;
      // },

      // async request(
      //   contractHash: Uint8Array,
      //   params: Uint8Array,
      //   result: Uint8Array,
      // ): Promise<number> {
      //   const verifier = {
      //     contract_hash: Hash.fromBytes(contractHash),
      //     params,
      //   };
      //   const verifierHash = Hash.digest(Verifier.encode(verifier));
      //   const blocks = await ctx.get(FulfillmentRegistry).getOrWait(
      //     verifierHash,
      //   );
      //   const body = blocks[0].body;
      //   if (body.byteLength <= result.byteLength) {
      //     result.set(body);
      //   }
      //   return body.byteLength;
      // },

      // result(data: Uint8Array): undefined {
      //   return undefined;
      // },

      debugLog(msg: Uint8Array): undefined {
        getDebugger().log(msg);
        return undefined;
      },
      debugPtr(name: Uint8Array, mem: Uint8Array, ptr: number): undefined {
        getDebugger().ptr(name, mem, ptr);
        return undefined;
      },
      debugBreak(): Promise<void> {
        return getDebugger().brk();
      },
    });

    return exitPromise;
  }
}
