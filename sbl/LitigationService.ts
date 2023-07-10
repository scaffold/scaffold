import BlockBuilder from './BlockBuilder.ts';
import { BlockExt } from './BlockMeta.ts';
import BlockService from './BlockService.ts';
import { collateralHash, hintHash } from './constants.ts';
import Context from './Context.ts';
import KeyService from './KeyService.ts';
import { CollateralContractParams } from './messages.ts';
import Hash from './util/Hash.ts';

export default class LitigationService {
  constructor(private ctx: Context) {}

  public litigateBlock(
    block: BlockExt,
    verified: boolean,
    hint?: Uint8Array,
  ) {
    block.passedVerification = verified;

    const collateral = this.ctx.get(BlockService).getCollateral(block);
    if (collateral.resolver !== undefined) {
      // Already resolved; too late
      return;
    }
    if (collateral.ledger.length === 0) {
      // No initial collateral posted
      return;
    }

    const amountFor = collateral.postedAmountFor;
    const amountAgainst = collateral.postedAmountAgainst +
      collateral.implicitAmountAgainst;

    const additionalCollateral = verified
      ? (amountAgainst << 1n) - amountFor
      : (amountFor << 1n) - amountAgainst;
    if (additionalCollateral > 0n) {
      const output = {
        amount: additionalCollateral,
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode({
            block_hash: block.hash,
            valid: verified,
            public_key: this.ctx.get(KeyService).getSelfPublicKey(),
            free_after: BigInt(this.ctx.config.timeProvider.now() + 10000),
          }),
        },
      };
      const collateralBlock = this.ctx.get(BlockBuilder).emit({
        body: hint,
        inputs: hint !== undefined ? [this.makeHintInput(block)] : [],
        outputs: [output],
      }, []);

      this.ctx.get(BlockService).create(collateralBlock);

      // const last = collateral.ledger[collateral.ledger.length - 1];

      // const input = {
      //   block_hash: last.block.hash,
      //   output_idx: last.outputIdx,
      //   amount: last.block.outputs[last.outputIdx].amount,
      // };
    }
  }

  public makeHintInput(block: BlockExt) {
    const hintOutput = {
      amount: 1n,
      verifier: { contract_hash: hintHash, params: new Uint8Array([]) },
    };

    const collateralBlock = this.ctx.get(BlockBuilder).emit({
      outputs: [hintOutput],
    }, []);

    return {
      block_hash: this.ctx.get(BlockService).create(collateralBlock),
      output_idx: 0,
      amount: 1n,
    };
  }
}
