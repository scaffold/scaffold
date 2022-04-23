import Context from '~/sbl/Context.ts';
import Hash from './util/Hash.ts';
import EpochContract from '~/graph/EpochContract.ts';
import * as epochMessages from '~/graph/epochMessages.ts';
import { QuestionSpec } from './messages.ts';

export default class RewardSpec {
  private epochHash: Hash;

  constructor(private ctx: Context) {
    this.epochHash = this.ctx.get(EpochContract).get().hash;
  }

  public getReward(questionSpec: QuestionSpec) {
    if (Hash.equals(questionSpec.contract_answer_hash, this.epochHash)) {
      const { height } = epochMessages.Params.decode(questionSpec.params);
      return 1000000n / height + 1000n;
    } else {
      return 0n;
    }
  }
}
