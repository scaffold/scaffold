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

// This predicts the amount of time a generator will take, on average.
export default class DurationPredictionService {
  private durationMsSum = 0;
  private durationCount = 0;

  constructor(private ctx: Context) {}

  public learn(_generator: Answer, durationMs: number) {
    this.durationMsSum += durationMs;
    this.durationCount++;
  }

  public predict(_generator: Answer) {
    return this.durationCount ? this.durationMsSum / this.durationCount : 1;
  }
}
