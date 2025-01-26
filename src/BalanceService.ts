import { Context } from './Context.ts';
import { KeyService } from './KeyService.ts';
import { accountHash } from './hashes.ts';
import { AccountContractParams, BlockOutput } from './messages.ts';
import { AvailableOutputManager } from './AvailableOutputManager.ts';

export class BalanceService {
  constructor(private ctx: Context) {}

  public onBalanceChange(
    cb: (balance: bigint) => void,
    until: AbortSignal,
    publicKey = this.ctx.get(KeyService).getSelfPublicKey(),
  ) {
    this.ctx.get(AvailableOutputManager).watch(
      { contractHash: accountHash, params: AccountContractParams.encode({ publicKey }) },
      until,
      (outputs) => cb(outputs.reduce((acc, cur) => acc + cur.amount, 0n)),
    );
  }
}
