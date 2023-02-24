import Context from './Context.ts';
import { formatPath } from './pathUtils.ts';
import { INTERRUPT_FLAG, WorkerChannelServer } from './worker/WorkerChannel.ts';
import {
  InitialMessage,
  JobMessage,
  WorkerComm,
} from './worker/workerTypes.ts';
import Hash from './util/Hash.ts';
import { Block, Verifier } from './messages.ts';
import { rootHash } from './constants.ts';
import { error } from './util/functional.ts';
import { ExecutorDriver } from './ExecutorDriverService.ts';

interface OpenFile {
  // TODO: Remove these, just used for debugging
  path: Uint8Array[];

  verifier: Promise<Verifier>;
  body?: Promise<Uint8Array>;

  // question: Question;
  // readerStream: Promise<IncentivizedStream<Uint8Array>>;
  // exposedData?: Promise<Uint8Array>;
}

export default class WorkerExecutor {
  constructor(private ctx: Context) {}

  // Note: This will transfer the input buffers, reducing their size to zero.
  public run<InputKeys extends string, OutputKeys extends string>(
    // codeVerifier: Verifier,
    generator: Uint8Array,
    inputs: Record<InputKeys, Uint8Array>,
    outputSpec: Record<OutputKeys, null>,
    driver: ExecutorDriver,
    cancel: Promise<typeof INTERRUPT_FLAG>,
  ): Promise<Record<OutputKeys, Uint8Array>> {
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

    const terminateFn = (_: typeof INTERRUPT_FLAG) => worker.terminate();
    let cancelCb = terminateFn;
    cancel.then((flag) => cancelCb(flag));

    const inodes = new Map<number, OpenFile>();
    const outputs: Record<string, { size: number; chunks: Uint8Array[] }> = {};

    let sendResult: (outputs: Record<OutputKeys, Uint8Array>) => void;
    const result = new Promise<Record<OutputKeys, Uint8Array>>(
      (resolve, reject) => {
        sendResult = resolve;
        cancel.then(reject);
      },
    );

    let sentJob = false;

    const getBody = (file: OpenFile) => {
      if (file.body === undefined) {
        file.body = file.verifier.then((verifier) =>
          new Promise((resolve, reject) => {
            if (cancelCb !== terminateFn) throw new Error('Internal error');
            cancelCb = reject;
            driver.request(verifier).then((body) => {
              if (cancelCb !== reject) throw new Error('Internal error');
              cancelCb = terminateFn;
              resolve(body);
            });
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

          const msg: JobMessage = {
            // codeVerifier: {
            //   contractHash: codeVerifier.contract_hash.toBytes(),
            //   params: codeVerifier.params,
            // },
            code: generator,
            inputs,
            outputSpec,
          };
          worker.postMessage(msg);

          // Only send one job, then end worker.
          worker.postMessage(undefined);

          sentJob = true;
        }
        return undefined;
      },
      exit(): undefined {
        sendResult(Object.fromEntries(
          Object.entries(outputs).map(([key, { size, chunks }]) => {
            const buf = new Uint8Array(size);
            chunks.reduce((offset, chunk) => {
              buf.set(chunk, offset);
              return offset + chunk.length;
            }, 0);
            return [key, buf];
          }),
        ) as Record<OutputKeys, Uint8Array>);
        return undefined;
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
        return undefined;
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
            const input = { contract_hash: contractHash, params };
            driver.notify(input);
            return input;
          }),
        });

        return undefined;
      },

      async read(
        inode: number,
        offset: number,
        dstBufs: Uint8Array[],
      ): Promise<number> {
        // The ONLY awaits in this function should be for getBody, since it handles cancels
        const body = await getBody(inodes.get(inode)!);

        let it = offset;
        for (const buf of dstBufs) {
          const limit = Math.min(it + buf.length, body.length);
          buf.set(body.subarray(it, limit));
          it = limit;
          if (it === body.length) {
            break;
          }
        }

        return it - offset;
      },

      async getSize(inode: number): Promise<number> {
        // The ONLY awaits in this function should be for getBody, since it handles cancels
        return (await getBody(inodes.get(inode)!)).byteLength;
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
    });

    return result;
  }
}
