import { BaseContext } from './BaseContext.ts';
import { Config } from './Config.ts';

export class Context extends BaseContext<Context> {
  constructor(public config: Config) {
    super();
  }

  protected override getThis() {
    return this;
  }
}
