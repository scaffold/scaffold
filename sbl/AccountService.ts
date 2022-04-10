import Context from './Context.ts';
import QuestionRegistry, { Question } from './QuestionRegistry.ts';
import AccountContract from '~/graph/AccountContract.ts';

export default class AccountService {
  private nextAccountIdx = 0n;

  constructor(private ctx: Context) {}

  public getNextAccountQuestion() {
    const contract = this.ctx.get(AccountContract).get();
    const params = this.ctx.get(AccountContract).makeParams(
      this.nextAccountIdx,
    );
    return this.ctx.get(QuestionRegistry).getBySpec({
      contract_answer_hash: contract.hash,
      params,
    });
  }
}
