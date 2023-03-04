import BlockBuilder from './BlockBuilder.ts';
import { BlockExt } from './BlockMeta.ts';
import BlockService from './BlockService.ts';
import { collateralHash } from './constants.ts';
import Context from './Context.ts';

export default class LitigationService {
  constructor(private ctx: Context) {}

  public litigateBlock(block: BlockExt, verified: boolean) {
    block.passedVerification = verified;

    const collateralFor = 2n;
    const collateralAgainst = 0n;

    if (verified) {
      if (collateralFor < collateralAgainst << 1n) {
        this.postCollateral(block, true);
      }
    } else {
      if (collateralAgainst < collateralFor << 1n) {
        this.postCollateral(block, false);
      }
    }
  }

  private postCollateral(block: BlockExt, side: boolean) {
    const verifier = {
      contract_hash: collateralHash,
      params: block.hash.toBytes(),
    };
    const body = side ? new Uint8Array([1]) : new Uint8Array([0]);

    const collateralBlock = this.ctx.get(BlockBuilder).build(verifier, body);
    this.ctx.get(BlockService).ingest(collateralBlock);
  }
}
