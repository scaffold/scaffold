import BlockBuilder from './BlockBuilder.ts';
import { BlockExt } from './BlockMeta.ts';
import BlockService from './BlockService.ts';
import { collateralHash } from './constants.ts';
import Context from './Context.ts';
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
    if (collateral.resolver!==undefined){
      return;
    }
    if (collateral.ledger.length===0){
      // No initial collateral posted
      return;
    }

    const needsCollateral=verified?collateral.totalAmountFor < collateral.totalAmountAgainst << 1n:collateral.totalAmountAgainst < collateral.totalAmountFor << 1n;
    if (needsCollateral) {const last = collateral.ledger[collateral.ledger.length-1]
      const lastVerifier=last.block.outputs[last.outputIdx].verifier;

    const outputAmount = collateral.totalAmountFor+collateral.totalAmountAgainst;
    const outputParams = CollateralContractParams.encode({ 
      collateral_input_idx:

          { name: 'collateral_input_idx', type: 'int' }, // -1 if this is the initial posting; -2 if we're not appending a link but just sending collateral for someone else's link
      { name: 'side', type: 'boolean' }, // false=FOR, true=AGAINST
      { name: 'public_key', type: 'bytes' }, // 33 bytes
      { name: 'free_after', type: 'long' },

 });

    this.ctx.get(BlockBuilder).emit({body:hint, outputs: []},[lastVerifier])

    const collateralBlock = ;
    this.ctx.get(BlockService).create(collateralBlock);
      this.postCollateral(block, verified, hint||new Uint8Array());
    }
  }

}
