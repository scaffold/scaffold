import secp from './util/secp.ts';
import Context from './Context.ts';
import callWithSyncRequestHandler from './callWithSyncRequestHandler.ts';
import Hash from './util/Hash.ts';
import QuestionService from './QuestionService.ts';
import DhtService from './DhtService.ts';
import { arrConcat } from './util/buffer.ts';
import SubscriptionService from './SubscriptionService.ts';
import AnswerRegistry, { Answer } from './AnswerRegistry.ts';
import QuestionRegistry, { Question } from './QuestionRegistry.ts';
import { PublishMessage } from './messages.ts';
import GraphUtils from './GraphUtils.ts';
import IncentiveService from './IncentiveService.ts';

// This predicts the market price of answering a question.
export default class DifficultyPredictionService {
  private difficultySum = 0n;
  private difficultyCount = 0n;

  constructor(private ctx: Context) {}

  public learn(_question: Question, difficulty: bigint) {
    this.difficultySum += difficulty;
    this.difficultyCount++;
  }

  public predict(_question: Question) {
    return this.difficultyCount
      ? this.difficultySum / this.difficultyCount
      : 1n;
  }
}
