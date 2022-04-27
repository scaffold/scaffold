import Context from './Context.ts';
import QuestionRegistry, { Question } from './QuestionRegistry.ts';
import AnswerRegistry from './AnswerRegistry.ts';
import AccountContract from '~/graph/AccountContract.ts';
import PublicationService from './PublicationService.ts';
import NodeService from './NodeService.ts';
import QuestionService from './QuestionService.ts';

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

  public publishAnswer(
    incentives: { question: Question; incentive: bigint }[],
  ) {
    const contract = this.ctx.get(AccountContract).get();
    const params = this.ctx.get(AccountContract).makeParams(
      this.nextAccountIdx,
    );

    const question = this.ctx.get(QuestionRegistry).getBySpec({
      contract_answer_hash: contract.hash,
      params,
    });

    const answer = this.ctx.get(AnswerRegistry).getByPub({
      question: { contract_answer_hash: contract.hash, params },
      inputs: [...question.incentives.values()].map(({ answerHash }) =>
        answerHash
      ),
      answer: new Uint8Array([]),
      licenses: incentives.map(({ question, incentive }) => ({
        question_hash: question.hash,
        incentive,
      })),
      timestamp: BigInt(Date.now()),
    });

    answer.isCorrect = true;
    answer.difficultyEstimate = 0n;
    this.ctx.get(QuestionService).addAnswerToQuestion(answer);

    this.ctx.get(NodeService).getAll().map((node) =>
      this.ctx.get(PublicationService).publish(node, answer)
    );

    this.nextAccountIdx++;
  }
}
