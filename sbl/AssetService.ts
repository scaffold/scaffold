import BlockBuilder from './BlockBuilder.ts';
import { BlockExt } from './BlockMeta.ts';
import BlockService from './BlockService.ts';
import { accountHash, collateralHash, hintHash } from './constants.ts';
import Context from './Context.ts';
import KeyService from './KeyService.ts';
import {
  AccountContractParams,
  Block,
  CollateralContractParams,
} from './messages.ts';
import { arrEquals } from './util/buffer.ts';
import Hash from './util/Hash.ts';

export interface Assets {
  frozen: { block: BlockExt; idx: number }[];
  getFrozenTotal(): bigint;
  // collateral: { block: BlockExt; idx: number }[];
  // getCollateralTotal(): bigint;
}

export default class AssetService {
  constructor(private ctx: Context) {}

  public getAssets(
    publicKey: Uint8Array = this.ctx.get(KeyService).getSelfPublicKey(),
  ): Assets {
    const frozen = this.ctx.get(BlockService)
      .getBlocksByOutput({
        contract_hash: accountHash,
        params: AccountContractParams.encode({ public_key: publicKey }),
      })
      .filter(({ block, idx }) => block.outputClaims[idx].length === 0);

    // const collateral = this.ctx.get(BlockService)
    //   .getBlocksByOutputFilter(
    //     collateralHash,
    //     (params) =>
    //       arrEquals(
    //         CollateralContractParams.decode(params).public_key,
    //         publicKey,
    //       ),
    //   )
    //   .filter(({ block, idx }) => block.outputClaims[idx].length === 0);

    return {
      frozen,
      getFrozenTotal: () =>
        frozen.reduce(
          (acc, { block, idx }) => acc + block.outputs[idx].amount,
          0n,
        ),
      // collateral: [],
      // getCollateralTotal: () => 0n,
    };
  }
}
