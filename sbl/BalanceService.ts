import Context from '~/sbl/Context.ts';
import KeyService from '~/sbl/KeyService.ts';
import BlockService from '~/sbl/BlockService.ts';
import { accountHash } from '~/sbl/constants.ts';
import { AccountContractParams } from '~/sbl/messages.ts';

export default class BalanceService {
  constructor(private ctx: Context) {}

  public getLiquidBalance(
    publicKey = this.ctx.get(KeyService).getSelfPublicKey(),
  ) {
    // TODO: Make sure we only return canonical outputs here
    return this.ctx.get(BlockService).getBlocksByOutput({
      contract_hash: accountHash,
      params: AccountContractParams.encode({ public_key: publicKey }),
    }).reduce(
      (acc, cur) =>
        cur.block.outputClaims[cur.idx].length === 0
          ? acc + cur.block.outputs[cur.idx].amount
          : acc,
      0n,
    );
  }
}
