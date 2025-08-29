import { Context } from './Context.ts';
import { Config } from './Config.ts';
import { MaybeDisposable } from './BaseContext.ts';

export class RestrictedContext extends Context {
  constructor(config: Config, private allow: { new (context: Context): unknown }[]) {
    super(config);
  }

  public override get<T extends object & MaybeDisposable>(Type: { new (context: Context): T }): T {
    if (!this.allow.includes(Type)) {
      throw new Error(`Cannot get ${Type.name} from a mockable context!`);
    }

    return super.get(Type);
  }
}
