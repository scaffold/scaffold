import Context from '~/sbl/Context.ts';
import Hash from './util/Hash.ts';
import EpochContract from '~/graph/EpochContract.ts';
import * as epochMessages from '~/graph/epochMessages.ts';
import { Question } from './messages.ts';

export default class RewardSpec {
  private epochHash: Hash;

  constructor(private ctx: Context) {
    this.epochHash = this.ctx.get(EpochContract).get().hash;
  }

  public getReward(question: Question) {
    if (Hash.equals(question.contract_hash, this.epochHash)) {
      const { height } = epochMessages.Params.decode(question.params);
      return 1000000n / height + 1000n;
    } else {
      return 0n;
    }
  }
}
