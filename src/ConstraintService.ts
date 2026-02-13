import { LogSystem } from './Config.ts';
import { Context } from './Context.ts';
import { Logger } from './Logger.ts';

export class ConstraintService {
  private log?: Logger;

  private constraints: { name: string; evaluate(): void }[] = [];

  constructor(private ctx: Context) {
    this.log = Logger.create(ctx, LogSystem.Constraint);
  }

  addConstraint(name: string, evaluator: () => void) {
    this.constraints.push({ name, evaluate: evaluator });
  }

  evaluate() {
    const result: { [key: string]: boolean } = {};
    for (const constraint of this.constraints) {
      try {
        constraint.evaluate();
        result[constraint.name] = true;
      } catch (err) {
        this.log?.error(
          `Constraint ${constraint.name} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        result[constraint.name] = false;
      }
    }
    this.log?.info('Constraint evaluation result', result);
  }
}
