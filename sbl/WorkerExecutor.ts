import Context from './Context.ts';
import ExposedPromise from './util/ExposedPromise.ts';
import QuestionService from './QuestionService.ts';
import { formatPath } from './worker/pathUtils.ts';
import { Contract, Script } from './scriptTypes.ts';
import { WorkerChannelServer } from './worker/WorkerChannel.ts';
import { WorkerComm, WorkerInit } from './worker/workerTypes.ts';
import { QuestionSpec } from './messages.ts';
import RootContract from '~/graph/RootContract.ts';
import { Answer } from './AnswerRegistry.ts';
import { error } from './util/functional.ts';

interface OpenFile {
  // TODO: Remove these, just used for debugging
  path: Uint8Array[];

  answer: Promise<Answer>;
  // question: QuestionSpec;
  // readerStream: Promise<IncentivizedStream<Uint8Array>>;
  // exposedData?: Promise<Uint8Array>;
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

    const rootLoaders: { [index: string]: Promise<Answer> } = {
      ext: Promise.resolve(ctx.get(RootContract).get()),
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
          answer: rootLoaders[name],
        });

        return undefined;
      },

      fsOpen(baseInode: number, key: Uint8Array, subInode: number): undefined {
        const path = [...inodes.get(baseInode)!.path, key];
        console.log(`Preopen ${formatPath(path)}`);

        let resolved = false;
        inodes.set(subInode, {
          path,
          answer: new Promise((resolve) => {
            console.log(`Read ${formatPath(path)}...`);
            inodes.get(baseInode)!.answer.then((parentAnswer) =>
              ctx.get(QuestionService).getCanonical({
                contract_answer_hash: parentAnswer.hash,
                params: key,
              }).onAnswer((answer) => {
                console.log(
                  `Read ${formatPath(path)} -> ${
                    formatPath([answer.data.slice(0, 128)])
                  }`,
                );

                if (resolved) {
                  hasDirtyInputs.resolve(true);
                } else {
                  resolved = true;
                  resolve(answer);
                }
              })
            );
          }),
        });

        return undefined;
      },

      async fsRead(
        inode: number,
        offset: number,
        dstBufs: Uint8Array[],
      ): Promise<number> {
        const answer = await inodes.get(inode)!.answer;

        let it = offset;
        for (const buf of dstBufs) {
          const limit = Math.min(it + buf.length, answer.data.length);
          buf.set(answer.data.subarray(it, limit));
          it = limit;
          if (it === answer.data.length) {
            break;
          }
        }

        return it - offset;
      },

      async fsGetSize(inode: number): Promise<number> {
        const answer = await inodes.get(inode)!.answer;
        return answer.data.length;
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
