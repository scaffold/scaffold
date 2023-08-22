import Context from './Context.ts';
import { AccountContractParams, Verifier } from './messages.ts';
import BlockService from './BlockService.ts';
import BlockBuilder from './BlockBuilder.ts';
import Hash from './util/Hash.ts';
import { accountHash } from '~/sbl/constants.ts';
import KeyService from '~/sbl/KeyService.ts';

export default class AccountService {
  // constructor(private ctx: Context) {
  //   const itv = ctx.config.timeProvider.setInterval(
  //     () => this.publishAnswer(),
  //     100,
  //   );
  //   this.ctx.onDestruct(() => ctx.config.timeProvider.clearInterval(itv));
  // }

  // public getNextAccountVerifier(): Verifier {
  //   return {
  //     contract_hash: accountHash,
  //     params: AccountContractParams.encode({
  //       public_key: this.ctx.get(KeyService).getSelfPublicKey(),
  //     }),
  //   };
  // }

  // private publishAnswer() {
  //   const verifier = this.getNextAccountVerifier();
  //   const block = this.ctx.get(BlockBuilder).emit({}, [verifier]);
  //   if (
  //     block.outputs.some((output) =>
  //       !Hash.equals(output.verifier.contract_hash, verifier.contract_hash)
  //     )
  //   ) {
  //     this.ctx.get(BlockService).create(block);
  //   }

  //   // const answer = this.ctx.get(AnswerRegistry).getOrCreate({
  //   //   question: { contract_hash: contract.hash, params },
  //   //   inputs: [...question.incentives.values()].map(({ answerHash }) =>
  //   //     answerHash
  //   //   ),
  //   //   answer: new Uint8Array([]),
  //   //   licenses: incentives.map(({ question, incentive }) => ({
  //   //     question: question.spec,
  //   //     incentive,
  //   //   })),
  //   //   timestamp: BigInt(Date.now()),
  //   // }, SELF_CONNECTION);

  //   // answer.isCorrect = true;
  //   // answer.difficultyEstimate = 0n;
  //   // this.ctx.get(QuestionService).addAnswerToQuestion(answer);

  //   // this.ctx.get(NodeService).getAll().map((node) =>
  //   //   this.ctx.get(PublicationService).publish(node, answer)
  //   // );
  // }
}
