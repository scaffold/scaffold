import secp from './util/secp.ts';
import BlockBuilder from './BlockBuilder.ts';
import { BlockExt } from './BlockMeta.ts';
import BlockService from './BlockService.ts';
import { dataHash, epochHash, generatorHash, rootHash } from './constants.ts';
import Context from './Context.ts';
import ExecutorDriverService, {
  ExecutorDriver,
} from './ExecutorDriverService.ts';
import FetchService from './FetchService.ts';
import LocalGeneratorService, {
  ANY_BODY_FLAG,
  INGENERABLE_FLAG,
} from './LocalGeneratorService.ts';
import { EpochInclusionProof, Verifier } from './messages.ts';
import { bin2str, str2bin } from './pathUtils.ts';
import { arrConcat, arrEquals } from './util/buffer.ts';
import { error, mapEntries } from './util/functional.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import WorkerExecutor from './WorkerExecutor.ts';
import { getOrCreate } from './util/map.ts';
import DataContract from './DataContract.ts';
import LitigationService from './LitigationService.ts';
import SpecialContractManager from './SpecialContractManager.ts';
import Logger from './Logger.ts';
import PacketCoder from '~/sbl/PacketCoder.ts';
import { MessageType } from '~/sbl/ConnectionService.ts';

const secret = secp.etc.randomBytes(32);

export default class ExecutorLauncherService {
  private attemptDupeFraction = Hash.fromFraction(0, 8);

  private extraContractIncentive: Map<HashPrimitive, number> = new Map();
  private extraGeneratorIncentive: Map<HashPrimitive, number> = new Map();

  constructor(private ctx: Context) {}

  public enqueueVerification(
    block: BlockExt,
    verifier: Verifier,
    extraIncentive: number,
  ) {
    const runHash = Hash.digestParts(Verifier.encode(verifier), block.body);
    if (this.extraContractIncentive.has(runHash.toPrimitive())) {
      this.extraContractIncentive.set(runHash.toPrimitive(), extraIncentive);
      return;
    } else {
      this.extraContractIncentive.set(runHash.toPrimitive(), extraIncentive);
    }

    const special = this.ctx.get(SpecialContractManager)
      .getContract(verifier.contract_hash);
    if (special) {
      this.ctx.get(ExecutorDriverService).run(
        verifier,
        {},
        () => this.extraContractIncentive.get(runHash.toPrimitive())!,
        async (driver, cancel) => {
          await driver.setAllocation({});

          const verified = await special.verify(
            verifier.params,
            block,
            (hash) =>
              driver.request({
                contract_hash: rootHash,
                params: hash.toBytes(),
              }),
          );

          this.ctx.get(LitigationService).litigateBlock(block, verified);
        },
      );
    }

    // TODO: Move to SpecialContractManager
    if (Hash.equals(verifier.contract_hash, dataHash)) {
      const hint = new Uint8Array([]);
      const verified = this.ctx.get(DataContract).verify(
        verifier.params,
        block.body,
        hint,
      );
      this.ctx.get(LitigationService).litigateBlock(block, verified, hint);
      return;
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
              body: block.body,
              stdin: new Uint8Array([]),
            },
            { stdout: null, stderr: null },
            driver,
            cancel,
          );

          console.log('STDOUT', bin2str(stdout));
          console.log('STDERR', bin2str(stderr));

          const verified = arrEquals(stdout, str2bin('PASS'));
          this.ctx.get(LitigationService).litigateBlock(block, verified);
        },
      );
    }
  }

  public enqueueGeneration(verifier: Verifier, extraIncentive: number) {
    const runHash = Hash.digest(Verifier.encode(verifier));
    if (this.extraGeneratorIncentive.has(runHash.toPrimitive())) {
      this.extraGeneratorIncentive.set(runHash.toPrimitive(), extraIncentive);
      return;
    } else {
      this.extraGeneratorIncentive.set(runHash.toPrimitive(), extraIncentive);
    }

    const getScore = () =>
      this.ctx.get(BlockService).getBlocksByOutput(verifier)
        .reduce((acc, { block, idx }) => {
          const { amount } = block.outputs[idx];
          const claims = block.outputClaims[idx];
          return claims.length === 0 && block.canonicality > 0
            ? acc + /* Math.exp(block.mergeableLogProbabilityValue) * */
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
            inputIdx: -1000,
            emitCorrect: this.shouldEmitCorrect(verifier),
            setFreeMarket: () => error('Not implemented'),
            setBody: (body) => error('Not implemented'),
            addOutput: (output) => error('Not implemented'),
            sign: () => error('Not implemented'),
            invert: (hash) => error('Not implemented'),
            request: (contract_hash, params) =>
              driver.request({ contract_hash, params }),
            notify: (contract_hash, params) =>
              driver.notify({ contract_hash, params }),
            fulfills: (block: BlockExt, outputIdx: number) =>
              driver.fulfills(block, outputIdx),
          });

          if (data !== INGENERABLE_FLAG) {
            this.createBlock(
              verifier,
              data !== ANY_BODY_FLAG ? data : undefined,
              driver.getInputs(),
              0,
            );
          }
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
            this.createBlock(verifier, stdout, driver.getInputs(), 0);
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
    data: Uint8Array | undefined,
    inputs: { block: BlockExt; outputIdx: number }[],
    durationMs: number,
  ) {
    const block = this.ctx.get(BlockBuilder).emit({
      inputs: inputs.map(({ block, outputIdx }) => ({
        block_hash: block.hash,
        output_idx: outputIdx,
        amount: block.outputs[outputIdx].amount,
        icebergDepth: block.iceberg_depth,
      })),
      body: data,
    }, [verifier]);
    const blockExt = this.ctx.get(BlockService).create(block);
    // answer.difficultyEstimate = BigInt(durationMs) *
    //   this.ctx.config.approxComputePricePerSecond / 1000n;
    // const hash = Hash.digest(Verifier.encode(verifier));

    // Special case for epoch blocks; we need to send the epoch inclusion proof to all inputs
    if (Hash.equals(verifier.contract_hash, epochHash)) {
      block.inputs.forEach(({ block_hash }, idx) =>
        this.ctx.get(BlockService).get(block_hash)?.from.forEach((node) =>
          node.defaultConn?.sendReliable(
            this.ctx.get(PacketCoder).encode(
              { block_hash, epoch_hash: blockExt.hash, input_indices: [idx] },
              EpochInclusionProof,
              MessageType.EpochInclusionProof,
            ),
          )
        )
      );
    }

    if (this.ctx.config.dbgVerifyGenerations) {
      this.enqueueVerification(blockExt, verifier, 0);
    } else {
      this.ctx.get(LitigationService).litigateBlock(blockExt, true);
    }
  }

  public snapshot() {
    return {
      extraContractIncentive: this.extraContractIncentive,
      extraGeneratorIncentive: this.extraGeneratorIncentive,
    };
  }
}
