import { Context } from './Context.ts';
import { Config } from './Config.ts';
import { MaybeDisposable } from './BaseContext.ts';

export class TestContext extends Context {
  constructor(config: Config, private allow: { new (context: Context): unknown }[]) {
    super(config);
  }

  public override mock<T extends object & MaybeDisposable>(
    Type: { new (context: Context): T },
    mock: T,
  ): void {
    super.mock(Type, mock);
  }

  public override get<T extends object & MaybeDisposable>(Type: { new (context: Context): T }): T {
    if (!this.allow.includes(Type)) {
      throw new Error(`Not allowed to get ${Type.name} in this test context!`);
    }

    return super.get(Type);
  }
}
