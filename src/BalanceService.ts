import Context from './Context.ts';
import KeyService from './KeyService.ts';
import BlockService from './BlockService.ts';
import { accountHash } from './constants.ts';
import { AccountContractParams } from './messages.ts';
import WeightService from './WeightService.ts';

export default class BalanceService {
  constructor(private ctx: Context) {}

  public getLiquidBalance(
    publicKey = this.ctx.get(KeyService).getSelfPublicKey(),
  ) {
    return this.ctx.get(BlockService).getBlocksByOutput({
      contract_hash: accountHash,
      params: AccountContractParams.encode({ publicKey }),
    }).reduce(
      (acc, cur) =>
        cur.block.outputClaims[cur.idx].length === 0 &&
          this.ctx.get(WeightService).isCanonical(cur.block)
          ? acc + cur.block.outputs[cur.idx].amount
          : acc,
      0n,
    );
  }
}
