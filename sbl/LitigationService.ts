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

    block.outputs.map(({ amount, verifier }, idx) => {
      if (!Hash.equals(verifier.contract_hash, collateralHash)) {
        return;
      }
      const canonicalClaims = block.outputClaims[idx].filter((claim) =>
        claim.canonicality > 0
      );
      if (canonicalClaims.length > 1) {
        throw new Error(`More than one canonical claim!!!`);
      }
      if (canonicalClaims.length === 0) {
        return;
      }
      canonicalClaims[0];
    });

    if (!block.postedCollateral.some(({ canonicality }) => canonicality > 0)) {
      const head = block.collateralChain.length
        ? block.collateralChain[block.collateralChain.length - 1]
        : block;
    }

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
    const verifiers = block.outputs.filter(({ verifier }) =>
      Hash.equals(verifier.contract_hash, collateralHash)
    ).map((x) => x.verifier);
    const body = CollateralContractBody.encode({ side, hint });

    const collateralBlock = this.ctx.get(BlockBuilder).build(verifiers, body);
    this.ctx.get(BlockService).create(collateralBlock);
  }
}
