import Hash from './util/Hash.ts';
import Context from './Context.ts';
import { Block, Claim, Incentive, Verifier } from './messages.ts';
import AccountContract from '../graph/AccountContract.ts';
import { arrEquals } from './util/buffer.ts';

export default class IncentiveCalculator {
  constructor(private ctx: Context) {}

  public getAvailableIncentive(verifier: Verifier, claims: Claim[]): bigint {
    let amount = claims.reduce((acc, cur) => acc + cur.amount, 0n);

    // Hack to let accounts start off with some funds
    if (
      Hash.equals(
        verifier.contract_hash,
        this.ctx.get(AccountContract).get(),
      ) && arrEquals(verifier.params, new Uint8Array([0x00]))
    ) {
      amount += 1000000n;
    }

    // TODO: Distribute epoch rewards here
    // 1e12 / second

    return amount;
  }
}
