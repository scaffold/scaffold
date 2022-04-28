import Context from './Context.ts';
import AppraisalProvider, { Action, Appraisal } from './AppraisalProvider.ts';

export default class ActionExecutor {
  private provider: ReturnType<AppraisalProvider['create']>;
  private executors: Map<Action['type'], (action: never) => void> = new Map();

  constructor(private ctx: Context) {
    this.provider = ctx.config.appraisalProvider.create(
      (action, prediction) => this.appraise(action, prediction),
    );
  }

  public registerExecutor<Type extends Action['type']>(
    type: Type,
    executor: (action: Action & { type: Type }) => void,
  ) {
    this.executors.set(type, executor);
  }

  public addAction(action: Action) {
    this.provider.requestAppraisal(action);
  }

  private appraise(action: Action, prediction: Appraisal) {
  }

  private execute(action: Action) {
    const executor = this.executors.get(action.type);
    if (!executor) {
      throw new Error(
        `No executor registered for type ${JSON.stringify(action.type)}`,
      );
    }
    (executor as (action: Action) => void)(action);
  }
}
