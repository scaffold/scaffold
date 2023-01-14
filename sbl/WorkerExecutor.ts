import Context from './Context.ts';
import ExposedPromise from './util/ExposedPromise.ts';
import { formatPath } from './pathUtils.ts';
import { WorkerChannelServer } from './worker/WorkerChannel.ts';
import {
  InitialMessage,
  JobMessage,
  WorkerComm,
} from './worker/workerTypes.ts';
import Hash from './util/Hash.ts';
import { Block, Verifier } from './messages.ts';
import { FulfillmentRegistry } from './registries.ts';
import { rootHash } from './constants.ts';
import NodeService from './NodeService.ts';
import { error } from './util/functional.ts';
import FetchService from './FetchService.ts';

interface OpenFile {
  // TODO: Remove these, just used for debugging
  path: Uint8Array[];

  verifier: Promise<Verifier>;
  block?: Promise<Block>;

  // question: Question;
  // readerStream: Promise<IncentivizedStream<Uint8Array>>;
  // exposedData?: Promise<Uint8Array>;
}

export default class WorkerExecutor {
  constructor(private ctx: Context) {}

  // Note: This will transfer the input buffers, reducing their size to zero.
  public run<InputKeys extends string, OutputKeys extends string>(
    verifier: Verifier,
    code: Uint8Array,
    inputs: Record<InputKeys, Uint8Array>,
    outputSpec: Record<OutputKeys, null>,
  ): {
    cancel(): void;
    result: Promise<
      { outputs: Record<OutputKeys, Uint8Array>; usedBlocks: Set<Block> }
    >;
    hasDirtyInputs: Promise<true>;
  } {
    const ctx = this.ctx;

    const worker = new Worker(
      new URL('./worker/worker.ts', import.meta.url).href,
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

    const inodes = new Map<number, OpenFile>();
    const outputs: Record<string, { size: number; chunks: Uint8Array[] }> = {};

    const result = ExposedPromise.create<
      { outputs: Record<OutputKeys, Uint8Array>; usedBlocks: Set<Block> }
    >();
    const hasDirtyInputs = ExposedPromise.create<true>();

    const usedBlocks: Set<Block> = new Set();
    let sentJob = false;

    const getBlock = (file: OpenFile) => {
      if (file.block === undefined) {
        file.block = file.verifier.then((verifier) =>
          new Promise((resolve) => {
            let resolved = false;
            ctx.get(FetchService).fetch(verifier, {}, (b) => {
              if (resolved) {
                hasDirtyInputs.resolve(true);
              } else {
                resolved = true;
                resolve(b);
              }
            });
          })
        );
      }
      return file.block;
    };

    const getBodyHash = (file: OpenFile) =>
      file.verifier.then(({ contract_hash, params }) =>
        Hash.equals(contract_hash, rootHash)
          ? Hash.fromBytes(params)
          : getBlock(file).then((block) => Hash.digest(block.body))
      );

    new WorkerChannelServer<WorkerComm>(worker, sigBuf, {
      ready(): undefined {
        if (!sentJob) {
          const msg: JobMessage = { code, inputs, outputSpec };
          worker.postMessage(msg, {
            // transfer: Object.values(inputs).map((buf) =>
            //   (buf as Uint8Array).buffer
            // ),
          });
          sentJob = true;
        }
        return undefined;
      },
      exit(): undefined {
        result.resolve({
          outputs: Object.fromEntries(
            Object.entries(outputs).map(([key, { size, chunks }]) => {
              const buf = new Uint8Array(size);
              chunks.reduce((offset, chunk) => {
                buf.set(chunk, offset);
                return offset + chunk.length;
              }, 0);
              return [key, buf];
            }),
          ) as Record<OutputKeys, Uint8Array>,
          usedBlocks,
        });
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
            ctx.get(NodeService).getAll().forEach((node) =>
              node.defaultConn?.sendReliable({
                BidMessage: { input, output: verifier, amount },
              })
            );
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
        const block = await getBlock(inodes.get(inode)!);
        usedBlocks.add(block);

        let it = offset;
        for (const buf of dstBufs) {
          const limit = Math.min(it + buf.length, block.body.length);
          buf.set(block.body.subarray(it, limit));
          it = limit;
          if (it === block.body.length) {
            break;
          }
        }

        return it - offset;
      },

      async getSize(inode: number): Promise<number> {
        const block = await getBlock(inodes.get(inode)!);
        usedBlocks.add(block);
        return block.body.length;
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

    return {
      cancel() {
        console.log(`Terminating worker...`);
        result.reject(new Error(`Cancelled`));
        // TODO: If we're waiting in Atomic.wait, we can wake the worker up and make it throw an exception.
        // This way we won't have to re-start the worker.
        // If the worker's just spinning in WASM, we have no alternative other than just terminating it.
        worker.terminate();
      },
      result,
      hasDirtyInputs,
    };
  }
}
