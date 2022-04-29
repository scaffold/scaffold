import Context from './Context.ts';
import AppraisalProvider, { Action, Appraisal } from './AppraisalProvider.ts';
import { RBTree } from 'std-latest/collections/rb_tree.ts';
import Hash from './util/Hash.ts';

const valuePerSecond = Symbol('valuePerSecond');
const tiebreak = Symbol('tiebreak');

type Entry = Action & {
  [valuePerSecond]: number;
  [tiebreak]: number;
  // key: Hash;
  // work(): Promise<void>;
};

let nextTiebreak = 0;

export default class ActionExecutor {
  private provider: ReturnType<AppraisalProvider['create']>;
  private executors: Map<Action['type'], (action: never) => void> = new Map();

  private queue: RBTree<Entry> = new RBTree((a, b) =>
    a[valuePerSecond] !== b[valuePerSecond]
      ? a[valuePerSecond] - b[valuePerSecond]
      : a[tiebreak] - b[tiebreak]
  );

  constructor(private ctx: Context) {
    // TODO: Use superclass to hook this in with ctx, and register executors.
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
    const entry = action as Entry;
    if (valuePerSecond in entry && tiebreak in entry) {
      this.queue.remove(entry);
    }

    entry[valuePerSecond] = prediction.value / prediction.computeSeconds;
    entry[tiebreak] = nextTiebreak++;

    this.queue.insert(entry);
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
