import { Action, Appraisal, AppraisalProvider } from './AppraisalProvider.ts';

export class DefaultAppraisalProvider implements AppraisalProvider {
  public create(onAppraise: (action: Action, prediction: Appraisal) => void) {
    return {
      requestAppraisal: (action: Action) => {
        onAppraise(action, {
          value: 1,
          compute: 1,
          memory: 1,
          lockedCoins: 1n,
        });
      },
      onExecute: (action: Action) => {},
      feedback: (action: Action, actual: Appraisal) => {},
    };
  }
}
