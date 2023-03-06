import BlockBuilder from './BlockBuilder.ts';
import { BlockExt } from './BlockMeta.ts';
import BlockService from './BlockService.ts';
import { collateralHash } from './constants.ts';
import Context from './Context.ts';
import { CollateralContractBody } from './messages.ts';

export default class LitigationService {
  constructor(private ctx: Context) {}

  public litigateBlock(
    block: BlockExt,
    verified: boolean,
    hint = new Uint8Array(),
  ) {
    block.passedVerification = verified;

    const collateralFor = 2n;
    const collateralAgainst = 0n;

    if (verified) {
      if (collateralFor < collateralAgainst << 1n) {
        this.postCollateral(block, true, hint);
      }
    } else {
      if (collateralAgainst < collateralFor << 1n) {
        this.postCollateral(block, false, hint);
      }
    }
  }

  private postCollateral(block: BlockExt, side: boolean, hint: Uint8Array) {
    const verifier = {
      contract_hash: collateralHash,
      params: block.hash.toBytes(),
    };
    const body = CollateralContractBody.encode({ side, hint });

    const collateralBlock = this.ctx.get(BlockBuilder).build(verifier, body);
    this.ctx.get(BlockService).ingest(collateralBlock);
  }
}
