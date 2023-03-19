import Context from './Context.ts';
import AccountContract from '~/graph/AccountContract.ts';
import NodeService from './NodeService.ts';
import { SELF_CONNECTION } from './ConnectionService.ts';
import { Verifier } from './messages.ts';
import BlockService from './BlockService.ts';
import BlockBuilder from './BlockBuilder.ts';
import Hash from './util/Hash.ts';

export default class AccountService {
  private nextAccountIdx = 0n;

  constructor(private ctx: Context) {
    const itv = setInterval(() => this.publishAnswer(), 100);
    this.ctx.onDestruct(() => clearInterval(itv));
  }

  public getNextAccountVerifier(): Verifier {
    const contractHash = this.ctx.get(AccountContract).get();
    const params = this.ctx.get(AccountContract).makeParams(
      this.nextAccountIdx,
    );
    return {
      contract_hash: contractHash,
      params,
    };
  }

  private publishAnswer() {
    const verifier = this.getNextAccountVerifier();
    const block = this.ctx.get(BlockBuilder).build(
      [verifier],
      new Uint8Array([]),
    );
    if (
      block.outputs.some((output) =>
        !Hash.equals(output.verifier.contract_hash, verifier.contract_hash)
      )
    ) {
      this.ctx.get(BlockService).create(block);
      this.nextAccountIdx++;
    }

    // const answer = this.ctx.get(AnswerRegistry).getOrCreate({
    //   question: { contract_hash: contract.hash, params },
    //   inputs: [...question.incentives.values()].map(({ answerHash }) =>
    //     answerHash
    //   ),
    //   answer: new Uint8Array([]),
    //   licenses: incentives.map(({ question, incentive }) => ({
    //     question: question.spec,
    //     incentive,
    //   })),
    //   timestamp: BigInt(Date.now()),
    // }, SELF_CONNECTION);

    // answer.isCorrect = true;
    // answer.difficultyEstimate = 0n;
    // this.ctx.get(QuestionService).addAnswerToQuestion(answer);

    // this.ctx.get(NodeService).getAll().map((node) =>
    //   this.ctx.get(PublicationService).publish(node, answer)
    // );
  }
}
