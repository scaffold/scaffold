import secp from './util/secp.ts';
import BlockBuilder from './BlockBuilder.ts';
import { BlockExt } from './BlockMeta.ts';
import BlockService from './BlockService.ts';
import { generatorHash, rootHash } from './constants.ts';
import Context from './Context.ts';
import ExecutorDriverService, {
  ExecutorDriver,
} from './ExecutorDriverService.ts';
import FetchService from './FetchService.ts';
import LocalGeneratorService from './LocalGeneratorService.ts';
import { Verifier } from './messages.ts';
import { bin2str } from './pathUtils.ts';
import { arrConcat, arrEquals } from './util/buffer.ts';
import { error, mapEntries } from './util/functional.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import WorkerExecutor from './WorkerExecutor.ts';
import { getOrCreate } from './util/map.ts';

const secret = secp.utils.randomBytes(32);

export default class ExecutorLauncherService {
  private attemptDupeFraction = Hash.fromFraction(0, 8);

  private extraContractIncentive: Map<HashPrimitive, number> = new Map();
  private extraGeneratorIncentive: Map<HashPrimitive, number> = new Map();

  constructor(private ctx: Context) {}

  public updateContract(
    verifier: Verifier,
    body: Uint8Array,
    extraIncentive: number,
  ) {
    const runHash = Hash.digestParts(Verifier.encode(verifier), body);
    if (this.extraContractIncentive.has(runHash.toPrimitive())) {
      this.extraContractIncentive.set(runHash.toPrimitive(), extraIncentive);
      return;
    } else {
      this.extraContractIncentive.set(runHash.toPrimitive(), extraIncentive);
    }

    const contractBlocks = this.ctx.get(BlockService).getBlocksByVerifier({
      contract_hash: rootHash,
      params: verifier.contract_hash.toBytes(),
    });
    if (contractBlocks.length) {
      const contractCode = contractBlocks[0].body;

      this.ctx.get(ExecutorDriverService).run(
        verifier,
        {},
        () => this.extraContractIncentive.get(runHash.toPrimitive())!,
        async (driver, cancel) => {
          await driver.setAllocation({});

          const { stdout, stderr } = await this.ctx.get(WorkerExecutor).run(
            // {
            //   contract_hash: generatorHash,
            //   params: verifier.contract_hash.toBytes(),
            // }
            contractCode,
            {
              contractHash: verifier.contract_hash.toBytes(),
              params: verifier.params,
              body,
              stdin: new Uint8Array([]),
            },
            { stdout: null, stderr: null },
            driver,
            cancel,
          );

          console.log('STDOUT', bin2str(stdout));
          console.log('STDERR', bin2str(stderr));
        },
      );
    }
  }

  public updateGenerator(verifier: Verifier, extraIncentive: number) {
    const runHash = Hash.digest(Verifier.encode(verifier));
    if (this.extraGeneratorIncentive.has(runHash.toPrimitive())) {
      this.extraGeneratorIncentive.set(runHash.toPrimitive(), extraIncentive);
      return;
    } else {
      this.extraGeneratorIncentive.set(runHash.toPrimitive(), extraIncentive);
    }

    const getScore = () =>
      this.ctx.get(BlockService).getBlocksByOutput(verifier)
        .reduce((acc, block) => {
          const idx = block.outputs.findIndex((o) =>
            Hash.equals(o.verifier.contract_hash, verifier.contract_hash) &&
            arrEquals(o.verifier.params, verifier.params)
          );
          if (idx === -1) {
            throw new Error(`Internal error`);
          }
          const { amount } = block.outputs[idx];
          const claims = block.outputClaims[idx];
          return claims.length === 0 && block.isCanonical
            ? acc - /* Math.exp(block.mergeableLogProbabilityValue) * */
              Number(amount)
            : acc;
        }, this.extraGeneratorIncentive.get(runHash.toPrimitive())!);

    const localGenerator = this.ctx.get(LocalGeneratorService).getGenerator(
      verifier.contract_hash,
    );
    if (localGenerator) {
      this.ctx.get(ExecutorDriverService).run(
        verifier,
        {},
        getScore,
        async (driver, _cancel) => {
          await driver.setAllocation({});

          const data = await localGenerator({
            ctx: this.ctx,
            contractHash: verifier.contract_hash,
            params: verifier.params,
            emitCorrect: this.shouldEmitCorrect(verifier),
            setFreeMarket: () => error('Not implemented'),
            request: (contract_hash, params) =>
              driver.request({ contract_hash, params }),
            notify: (contract_hash, params) =>
              driver.notify({ contract_hash, params }),
          });

          this.createBlock(verifier, data, driver.getInputBlocks(), 0);
        },
      );
    } else {
      const generatorBlocks = this.ctx.get(BlockService).getBlocksByVerifier({
        contract_hash: generatorHash,
        params: verifier.contract_hash.toBytes(),
      });
      if (generatorBlocks.length) {
        const generatorCode = generatorBlocks[0].body;

        this.ctx.get(ExecutorDriverService).run(
          verifier,
          {},
          getScore,
          async (driver, cancel) => {
            await driver.setAllocation({ webWorkerCount: 1 });

            const { stdout, stderr } = await this.ctx.get(WorkerExecutor).run(
              // {
              //   contract_hash: generatorHash,
              //   params: verifier.contract_hash.toBytes(),
              // }
              generatorCode,
              {
                contractHash: verifier.contract_hash.toBytes(),
                params: verifier.params,
                emitCorrect: new Uint8Array([
                  this.shouldEmitCorrect(verifier) ? 1 : 0,
                ]),
                stdin: new Uint8Array([]),
              },
              { stdout: null, stderr: null },
              driver,
              cancel,
            );

            console.log('STDOUT', bin2str(stdout));
            console.log('STDERR', bin2str(stderr));
            this.createBlock(verifier, stdout, driver.getInputBlocks(), 0);
          },
        );
      }
    }
  }

  private shouldEmitCorrect(verifier: Verifier) {
    return Hash.cmp(
      Hash.digest(
        arrConcat(secret, verifier.contract_hash.toBytes(), verifier.params),
      ),
      this.attemptDupeFraction,
    ) === 1;
  }

  private createBlock(
    verifier: Verifier,
    data: Uint8Array,
    inputs: BlockExt[],
    durationMs: number,
  ) {
    console.log('Completed generator', verifier, bin2str(data));
    const block = this.ctx.get(BlockBuilder).build(verifier, data);
    this.ctx.get(BlockService).ingest(block);
    // answer.difficultyEstimate = BigInt(durationMs) *
    //   this.ctx.config.approxComputePricePerSecond / 1000n;
    const hash = Hash.digest(Verifier.encode(verifier));
  }

  public snapshot() {
    return {
      extraContractIncentive: this.extraContractIncentive,
      extraGeneratorIncentive: this.extraGeneratorIncentive,
    };
  }
}
