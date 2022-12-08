import secp from './util/secp.ts';
import Hash from './util/Hash.ts';
import Context from './Context.ts';
import { GeneratorRegistry, IncentiveRegistry } from './registries.ts';
import WorkPicker from './WorkPicker.ts';
import { arrConcat } from './util/buffer.ts';
import { Block, Verifier } from './messages.ts';
import callWithSyncRequestHandler from './callWithSyncRequestHandler.ts';
import BlockService from './BlockService.ts';
import BlockBuilder from './BlockBuilder.ts';

const secret = secp.utils.randomBytes(32);
const wasmMagic = new Uint8Array([0, 0x61, 0x73, 0x6D]);

export default class WorkLoop {
  private attemptDupeFraction = Hash.fromFraction(1, 8);
  private running: Hash[] = [];

  constructor(private ctx: Context) {
    const itv = setInterval(() => this.tick(), 100);
    this.ctx.onDestruct(() => clearInterval(itv));
  }

  private async tick() {
    const launch = this.ctx.get(WorkPicker).pick(this.running);
    if (launch) {
      this.running.push(launch.key);
      await this.run(launch.generator, launch.verifier);
    }
  }

  private async run(generator: Uint8Array, verifier: Verifier) {
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
            true,
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
