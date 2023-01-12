import secp from './util/secp.ts';
import BlockBuilder from './BlockBuilder.ts';
import BlockService from './BlockService.ts';
import Context from './Context.ts';
import Logger from './Logger.ts';
import { Block, Verifier } from './messages.ts';
import {
  RequestsByGenerationStore,
  WorkableIncentivesStore,
} from './stores.ts';
import { arrConcat } from './util/buffer.ts';
import Hash from './util/Hash.ts';
import WorkQueueUtil from './util/WorkQueue.ts';
import { FulfillmentRegistry } from './registries.ts';
import IncentiveService from './IncentiveService.ts';
import WorkerExecutor from './WorkerExecutor.ts';

const useLocalExecution = false;
const secret = secp.utils.randomBytes(32);
const dummyWork = async () => {};

class NeedsMoreDataError extends Error {
  constructor() {
    super();
  }
}

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
      console.log('RUN MUT', hash.toHex(), work?.verifier.params, work?.amount);

      if (work !== undefined) {
        if (work.amount > 0n) {
          throw new Error(`Invalid amount`);
        }

        this.set(
          hash,
          -Number(work.amount),
          () => this.run(work.generator.body, work.verifier, work.amount),
        );
      } else {
        this.set(hash, 0, dummyWork);
      }
    });
  }

  private async run(
    generator: Uint8Array,
    verifier: Verifier,
    incentive: bigint,
  ) {
    console.log('RUN START', verifier.params);
    await new Promise((resolve) => {});

    console.warn(`Running ${this.ctx.get(Logger).serialize(verifier)}`);

    const emitCorrect = Hash.cmp(
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

    if (useLocalExecution) {
      // TODO: This is kinda hacky
      const generationHash = RequestsByGenerationStore.hash(
        verifier,
        generator,
      );

      const script = eval(new TextDecoder().decode(generator));
      await this.callWithSyncRequestHandler<Uint8Array>(
        verifier,
        (handler, notifier) =>
          script(
            verifier.contract_hash,
            verifier.params,
            emitCorrect,
            handler,
            notifier,
          ),
        incentive,
        generationHash,
        onDone,
      );

      console.log('RUN DONE', verifier.params);
    } else {
      debugger;
      const emitCorrect = true;
      const { cancel, result, hasDirtyInputs } = this.ctx.get(WorkerExecutor)
        .run(verifier, generator, {
          contractHash: verifier.contract_hash.toBytes(),
          params: verifier.params,
          emitCorrect: new Uint8Array([emitCorrect ? 1 : 0]),
        }, { answer: null });
      result.then((out) => console.log('DONE', out));
      result.then(({ outputs: { answer: data }, usedBlocks }) => {
        onDone(data, [...usedBlocks], 0);
        hasDirtyInputs.then(() => console.error(`Dirty inputs!`));
      });
    }
  }

  private async callWithSyncRequestHandler<T>(
    verifier: Verifier,
    func: (
      handler: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      notifier: (contractHash: Hash, params: Uint8Array) => void,
    ) => T | Promise<T>,
    incentive: bigint,
    generationHash: Hash,
    onDone: (answer: T, inputs: Block[], durationMs: number) => void,
  ) {
    const requests: Verifier[] = [];

    try {
      const inputs: Block[] = [];
      const startTime = Date.now();
      const out = await func((contractHash: Hash, params: Uint8Array) => {
        const innerVerifier = { contract_hash: contractHash, params };
        const verifierHash = Hash.digest(Verifier.encode(innerVerifier));
        const blocks = this.ctx.get(FulfillmentRegistry).getOrWait(
          verifierHash,
        );
        if (blocks instanceof Promise) {
          requests.push(innerVerifier);

          // this.ctx.get(IncentiveService).incentivize(
          //   innerVerifier,
          //   incentive / 2n,
          // );

          // this.ctx.get(NodeService).getAll().forEach((node) =>
          //   node.defaultConn?.sendReliable({
          //     BidMessage: { verifier: innerVerifier, output: verifier },
          //   })
          // );

          blocks.then(() =>
            this.callWithSyncRequestHandler(
              verifier,
              func,
              incentive,
              generationHash,
              onDone,
            )
          );
          throw new NeedsMoreDataError();
        } else {
          const block = blocks[0];
          inputs.push(block);
          return block.body;
        }
      }, (contractHash: Hash, params: Uint8Array) => {
        const innerVerifier = { contract_hash: contractHash, params };
        const verifierHash = Hash.digest(Verifier.encode(verifier));
        const blocks = this.ctx.get(FulfillmentRegistry).get(verifierHash);
        if (!blocks) {
          requests.push(innerVerifier);

          // this.ctx.get(IncentiveService).incentivize(
          //   innerVerifier,
          //   incentive / 2n,
          // );

          // this.ctx.get(NodeService).getAll().forEach((node) =>
          //   node.defaultConn?.sendReliable({
          //     BidMessage: { verifier: innerVerifier, output: verifier },
          //   })
          // );
        }
      });

      onDone(out, inputs, Date.now() - startTime);
      // this.ctx.get(RequestsByGenerationStore).set(generationHash, undefined);
      this.ctx.get(RequestsByGenerationStore).update(generationHash, 0n, []);
    } catch (err) {
      if (err instanceof NeedsMoreDataError) {
        // Needs more data. Just wait for it.
        // this.ctx.get(RequestsByGenerationStore).set(generationHash, {
        //   incentive: incentive < -1n ? incentive + 1n : 0n,
        //   requests,
        // });
        this.ctx.get(RequestsByGenerationStore).update(
          generationHash,
          incentive < -1n ? incentive + 1n : 0n,
          requests,
        );
      } else {
        throw err;
      }
    }
  }
}
