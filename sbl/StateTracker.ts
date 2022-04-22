import { Answer } from './AnswerRegistry.ts';
import Context from './Context.ts';
import QuestionService from './QuestionService.ts';
import { QuestionSpec } from './messages.ts';
import StateTrackerUtil from './util/StateTracker.ts';

export default class StateTracker
  extends StateTrackerUtil<QuestionSpec, Answer> {
  constructor(private ctx: Context) {
    super((key: QuestionSpec, onState: (state: Answer) => void) => {
      const questionSub = this.ctx.get(QuestionService).getCanonical(key);
      questionSub.incentivize(100000n);
      return questionSub.onAnswer(onState);
    });
  }
}
