import Context from './Context.ts';
import QuestionRegistry, { Question } from './QuestionRegistry.ts';
import AccountService from './AccountService.ts';

export default class IncentiveService {
  private pending: { question: Question; incentive: bigint }[] = [];

  constructor(private ctx: Context) {}

  public incentivize(question: Question, incentive: bigint) {
    this.pending.push({ question, incentive });
  }

  public popIncentives(amount: bigint) {
    // Sort in order of increasing incentive
    this.pending.sort((a, b) =>
      a.incentive > b.incentive ? 1 : a.incentive < b.incentive ? -1 : 0
    );

    const res: { question: Question; incentive: bigint }[] = [];

    while (amount > 0n) {
      const head = this.pending.pop();
      if (!head) {
        res.push({
          question: this.ctx.get(AccountService).getNextAccountQuestion(),
          incentive: amount,
        });
        break;
      }

      if (head.incentive <= amount) {
        amount -= head.incentive;
        res.push(head);
      } else {
        this.pending.push({
          question: head.question,
          incentive: head.incentive - amount,
        });
        res.push({
          question: head.question,
          incentive: amount,
        });
      }
    }

    return res;
  }
}
