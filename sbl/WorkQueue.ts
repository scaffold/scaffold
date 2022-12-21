import secp from './util/secp.ts';
import BlockBuilder from './BlockBuilder.ts';
import BlockService from './BlockService.ts';
import callWithSyncRequestHandler from './callWithSyncRequestHandler.ts';
import Context from './Context.ts';
import Logger from './Logger.ts';
import { Verifier } from './messages.ts';
import { WorkableIncentivesStore } from './stores.ts';
import { arrConcat } from './util/buffer.ts';
import Hash from './util/Hash.ts';
import WorkQueueUtil from './util/WorkQueue.ts';

const secret = secp.utils.randomBytes(32);
const wasmMagic = new Uint8Array([0, 0x61, 0x73, 0x6D]);
const dummyWork = async () => {};

export default class WorkQueue extends WorkQueueUtil {
  // private attemptDupeFraction = Hash.fromFraction(1, 8);
  private attemptDupeFraction = Hash.fromFraction(0, 8);

  constructor(private ctx: Context) {
    super();

    ctx.onDestruct(() => this.setWorkerCount(0));

    const idx = setInterval(() => this.cleanup(), 1000);
    ctx.onDestruct(() => clearInterval(idx));

    this.setWorkerCount(ctx.config.initialWorkerCount);

    ctx.get(WorkableIncentivesStore).onMutate((hash, _, work) => {
      if (work !== undefined) {
        this.set(
          hash,
          -Number(work.amount),
          () => this.run(work.generator.body, work.verifier),
        );
      } else {
        this.set(hash, 0, dummyWork);
      }
    });
  }

  private async run(generator: Uint8Array, verifier: Verifier) {
    console.warn(`Running ${this.ctx.get(Logger).serialize(verifier)}`);

    const attemptCorrect = Hash.cmp(
      Hash.digest(
        arrConcat(secret, verifier.contract_hash.toBytes(), verifier.params),
      ),
      this.attemptDupeFraction,
    ) === 1;

    const onDone = (data: Uint8Array, inputs: Block[], durationMs: number) => {
      const block = this.ctx.get(BlockBuilder).build(verifier, data);
      this.ctx.get(BlockService).ingest(block);
      // answer.difficultyEstimate = BigInt(durationMs) *
      //   this.ctx.config.approxComputePricePerSecond / 1000n;
    };

    const script = eval(new TextDecoder().decode(generator));
    if (typeof script === 'object') {
      // const emitCorrect = true;
      // const { cancel, result, hasDirtyInputs } = this.ctx.get(WorkerExecutor)
      //   .run(script, {
      //     contractHash: verifier.contract_hash.toBytes(),
      //     params: verifier.params,
      //     emitCorrect: new Uint8Array([emitCorrect ? 1 : 0]),
      //   }, { answer: null });
      // result.then((out) => console.log('DONE', out));
      // result.then(({ outputs: { answer: data }, usedAnswers }) => {
      //   onDone(data, [...usedAnswers], 0);
      //   hasDirtyInputs.then(() => {});
      // });
    } else if (typeof script === 'function') {
      callWithSyncRequestHandler<Uint8Array>(
        this.ctx,
        verifier,
        (handler, notifier) =>
          script(
            verifier.contract_hash,
            verifier.params,
            attemptCorrect,
            handler,
            notifier,
          ),
        onDone,
      );
    } else {
      throw new Error(`Invalid script type: ${typeof script}`);
    }
  }
}
