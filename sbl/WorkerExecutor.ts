import Context from './Context.ts';
import ExposedPromise from './util/ExposedPromise.ts';
import QuestionService from './QuestionService.ts';
import Hash from './util/Hash.ts';
import { formatPath, str2bin } from './pathUtils.ts';
import rootContract from './rootContract.ts';
import { decode, encode } from './transportUtils.ts';
import { Contract, Script } from './types.ts';
import { WorkerChannelServer } from './worker/WorkerChannel.ts';
import { WorkerComm, WorkerInit } from './worker/workerTypes.ts';

interface OpenFile {
  // TODO: Remove these, just used for debugging
  path: Uint8Array[];

  readerStream: Promise<IncentivizedStream<Uint8Array>>;
  exposedData?: Promise<Uint8Array>;
}

export default class WorkerExecutor {
  constructor(private context: Context) {}

  // Note: This will transfer the input buffers, reducing their size to zero.
  public run<InputKeys extends string, OutputKeys extends string>(
    script: Script,
    inputs: Record<InputKeys, Uint8Array>,
    outputSpec: Record<OutputKeys, null>,
    onUseExternalInput: (path: Uint8Array[], contents: Uint8Array) => void,
  ): {
    cancel(): void;
    result: Promise<Record<OutputKeys, Uint8Array>>;
    hasDirtyInputs: Promise<true>;
  } {
    const ctx = this.context;

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
    worker.postMessage({ sigBuf });

    //   {
    //     eval: true,
    //     workerData,
    //     transferList: Object.entries(inputs).map(
    //       ([key, buf]) => (buf as Uint8Array).buffer,
    //     ),
    //   },

    const inodes = new Map<number, OpenFile>();
    const outputs: Record<string, { size: number; chunks: Uint8Array[] }> = {};

    const result = ExposedPromise.create<Record<OutputKeys, Uint8Array>>();
    const hasDirtyInputs = ExposedPromise.create<true>();

    const rootLoaders: {
      [index: string]: () => Promise<IncentivizedStream<Uint8Array>>;
    } = {
      ext: async () => {
        const stream = new IncentivizedStream<Uint8Array>(() => {});
        stream.emit(encode(await rootContract));
        return stream;
      },
    };

    const getInodeContents = (inode: number): Promise<Uint8Array> => {
      const file = inodes.get(inode);
      if (!file) {
        throw new Error(`Invalid inode ${inode}`);
      }
      if (!file.exposedData) {
        console.log(`Read ${formatPath(file.path)}...`);
        const promise = ExposedPromise.create<Uint8Array>();
        file.readerStream.then((stream) =>
          stream.on(0, (data) => {
            promise.then((prev) => {
              prev !== data && hasDirtyInputs.resolve(true);
            });

            promise.resolve(data);
          })
        );
        file.exposedData = promise;
        promise.then((contents) =>
          console.log(
            `Read ${formatPath(file.path)} -> ${
              formatPath([
                contents.slice(0, 128),
              ])
            }`,
          )
        );
      }
      return file.exposedData;
    };

    new WorkerChannelServer<WorkerComm>(worker, sigBuf, {
      ready() {
        return undefined;
      },
      exit() {
        result.resolve(
          Object.fromEntries(
            Object.entries(outputs).map(([key, { size, chunks }]) => {
              const buf = new Uint8Array(size);
              chunks.reduce((offset, chunk) => {
                buf.set(chunk, offset);
                return offset + chunk.length;
              }, 0);
              return [key, buf];
            }),
          ) as Record<OutputKeys, Uint8Array>,
        );
        return undefined;
      },

      fsRoot(name: string, inode: number): undefined {
        inodes.set(inode, {
          path: [],
          readerStream: rootLoaders[name](),
        });

        return undefined;
      },

      fsOpen(baseInode: number, key: Uint8Array, subInode: number): undefined {
        const path = [
          ...(inodes.get(baseInode)?.path || [str2bin('__error')]),
          key,
        ];
        console.log(`Preopen ${formatPath(path)}`);

        inodes.set(subInode, {
          path,
          readerStream: getInodeContents(baseInode).then((parentContents) => {
            const contract = decode(parentContents) as Contract;
            // Assume valid Contract for now
            // TODO: Binary format

            const contractHash = Hash.digest(parentContents);

            return ctx
              .get(QuestionService)
              .getCanonical({ contractHash, params: key })
              .map(({ data }) => data);
          }),
        });

        return undefined;
      },

      async fsRead(
        inode: number,
        offset: number,
        dstBufs: Uint8Array[],
      ): Promise<number> {
        const contents = await getInodeContents(inode);

        let it = offset;
        for (const buf of dstBufs) {
          const limit = Math.min(it + buf.length, contents.length);
          buf.set(contents.subarray(it, limit));
          it = limit;
          if (it === contents.length) {
            break;
          }
        }

        return it - offset;
      },

      async fsGetSize(inode: number): Promise<number> {
        const contents = await getInodeContents(inode);
        return contents.length;
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
    });

    return {
      cancel() {
        console.log(`Terminating worker...`);
        result.reject(new Error(`Cancelled`));
        worker.terminate();
      },
      result,
      hasDirtyInputs,
    };
  }
}
