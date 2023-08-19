import BlockBuilder from './BlockBuilder.ts';
import BlockService from './BlockService.ts';
import { collateralHash, epochInclusionHash, hintHash } from './constants.ts';
import Context from './Context.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import KeyService from './KeyService.ts';
import { CollateralContractParams, EpochInclusionParams } from './messages.ts';
import Hash from './util/Hash.ts';
import FactService from '~/sbl/FactService.ts';

const publicationDelay = 2000;

const max = (a: bigint, b: bigint) => a > b ? a : b;

export default class LitigationService {
  private timeouts = new Set<number>();

  constructor(private ctx: Context) {
    ctx.onDestruct(() =>
      this.timeouts.forEach((timeout) =>
        ctx.config.timeProvider.clearTimeout(timeout)
      )
    );
  }

  public litigateBlock(
    block: BlockFact,
    verified: boolean,
    hint?: Uint8Array,
  ) {
    block.passedVerification = verified;

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

    const voteBlock = this.ctx.get(BlockBuilder).emit({
      outputs: [{
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode({
            block_hash: block.hash,
            valid: verified,
            public_key: this.ctx.get(KeyService).getSelfPublicKey(),
            free_after: BigInt(this.ctx.config.timeProvider.now() + 10000),
            hint: hint ?? new Uint8Array([]),
          }),
        },
        amount: additionalCollateral,
      }],
    }, []);
    const voteExt = this.ctx.get(BlockService).create(voteBlock, false);

    const incentiveBlock = this.ctx.get(BlockBuilder).emit({
      outputs: [{
        verifier: {
          contract_hash: epochInclusionHash,
          params: EpochInclusionParams.encode({ hash: voteExt.hash }),
        },
        amount: 10n,
      }],
    }, []);
    this.ctx.get(BlockService).create(incentiveBlock);

    const timeout = this.ctx.config.timeProvider.setTimeout(() => {
      this.ctx.get(FactService).publish(voteExt);
      this.timeouts.delete(timeout);
    }, publicationDelay);
    this.timeouts.add(timeout);
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
