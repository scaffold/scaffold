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

// This predicts the probability that an answer will become canonical.
export default class CanonicalityPredictionService {
  private canonicalitySum = 0;
  private canonicalityCount = 0;

  constructor(private ctx: Context) {}

  public learn(_answer: Answer, isCanonical: boolean) {
    this.canonicalitySum += isCanonical ? 1 : 0;
    this.canonicalityCount++;
  }

  public predict(_answer: Answer) {
    return this.canonicalityCount
      ? this.canonicalitySum / this.canonicalityCount
      : 1;
  }
}
