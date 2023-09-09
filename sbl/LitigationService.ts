import BlockBuilder from './BlockBuilder.ts';
import BlockService from './BlockService.ts';
import { collateralHash, epochInclusionHash, hintHash } from './constants.ts';
import Context from './Context.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import KeyService from './KeyService.ts';
import {
  BlockInput,
  CollateralContractParams,
  EpochInclusionParams,
} from './messages.ts';
import Hash from './util/Hash.ts';
import FactService from '~/sbl/FactService.ts';
import FrontierMonitorService from '~/sbl/FrontierMonitorService.ts';

const max = (a: bigint, b: bigint) => a > b ? a : b;

export default class LitigationService {
  constructor(private ctx: Context) {}

  public litigateBlock(
    block: BlockFact,
    verified: boolean,
    hint?: Uint8Array,
  ) {
    if (block.passedVerification === verified) {
      return;
    } else if (block.passedVerification === !verified) {
      throw new Error(
        `Cannot change the verified status of a block from ${block.passedVerification} to ${verified}!`,
      );
    }

    block.passedVerification = verified;

    const outputs: BlockInput[] = [];
    this.ctx.get(FrontierMonitorService).monitorOutput(
      collateralHash,
      block.hash.toBytes(),
      () => {},
      () => {},
    );

    const collateral = this.ctx.get(BlockService).getCollateral(block);
    if (collateral.resolver !== undefined) {
      // Already resolved; too late
      return;
    }

    const amountFor = collateral.postedAmountFor;
    const amountAgainst = collateral.postedAmountAgainst;
    // + collateral.implicitAmountAgainst;

    const additionalCollateral = verified
      ? max(1000n, amountAgainst << 1n) - amountFor
      : max(1000n, amountFor << 1n) - amountAgainst;
    if (additionalCollateral <= 0n) {
      return;
    }

    this.ctx.get(BlockBuilder).publish({
      outputs: [{
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode({
            block_hash: block.hash,
            valid: verified,
            public_key: this.ctx.get(KeyService).getSelfPublicKey(),
            // free_after: BigInt(this.ctx.config.timeProvider.now() + 10000),
            hint: hint ?? new Uint8Array([]),
          }),
        },
        amount: additionalCollateral,
      }],
    });
  }

  private publishResolution(block: BlockFact) {
    block.collateralizations;

    const inputs: BlockInput[] = [];
    this.ctx.get(FrontierMonitorService).monitorOutput(
      collateralHash,
      block.hash.toBytes(),
      (blockHash, outputIdx) =>
        inputs.push({ block_hash: blockHash, output_idx: outputIdx }),
      () => {
        throw new Error(`Shouldn't be called`);
      },
    ).releaseMonitor();

    // this.ctx.get(BlockBuilder).publish();
  }

  // public makeHintInput(block: BlockFact) {
  //   const hintOutput = {
  //     amount: 1n,
  //     verifier: { contract_hash: hintHash, params: new Uint8Array([]) },
  //   };

  //   const collateralBlock = this.ctx.get(BlockBuilder).emit({
  //     outputs: [hintOutput],
  //   }, []);

  //   return {
  //     block_hash: this.ctx.get(BlockService).create(collateralBlock),
  //     output_idx: 0,
  //     amount: 1n,
  //   };
  // }
}
