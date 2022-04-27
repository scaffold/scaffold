import Context from './Context.ts';
import QuestionRegistry, { Question } from './QuestionRegistry.ts';
import AccountService from './AccountService.ts';

export default class IncentiveService {
  private pending: {
    question: Question;
    incentive: bigint;
    forceAfter: number;
  }[] = [];

  constructor(private ctx: Context) {
    const itv = setInterval(() => this.forceIncentives(), 100);
    this.ctx.onDestruct(() => clearInterval(itv));
  }

  private forceIncentives() {
    const force: { question: Question; incentive: bigint }[] = [];
    this.pending = this.pending.filter((entry) => {
      if (entry.forceAfter) {
        entry.forceAfter--;
        return true;
      } else {
        force.push(entry);
        return false;
      }
    });

    console.log('force', force.length, this.pending.length);

    if (force.length) {
      this.ctx.get(AccountService).publishAnswer(force);
    }
  }

  public incentivize(question: Question, incentive: bigint, forceAfter = 1) {
    if (incentive > 0n) {
      question.selfIncentive += incentive;
      this.pending.push({ question, incentive, forceAfter });
    }
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
        head.question.selfIncentive -= head.incentive;
        res.push(head);
      } else {
        head.question.selfIncentive -= amount;
        this.pending.push({
          question: head.question,
          incentive: head.incentive - amount,
          forceAfter: head.forceAfter,
        });
        res.push({
          question: head.question,
          incentive: amount,
        });
        break;
      }
    }

    return res;
  }
}
