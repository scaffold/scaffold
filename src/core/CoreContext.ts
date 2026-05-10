import { BaseContext } from '../util/BaseContext.ts';

interface Config1 {
  a: number;
}
interface Config2 {
  b: string;
}

interface Ctx1 {
  config: Config1;
  get<T extends object>(Type: new (ctx: this) => T): T;
}
interface Ctx2 {
  config: Config2;
  get<T extends object>(Type: new (ctx: this) => T): T;
}

class X {
  constructor(private ctx: Ctx1) {}
  doX(): void {}
}
class Y {
  constructor(private ctx: Ctx1) {
    ctx.get(X).doX();
  }
}
class Z {
  constructor(private ctx: Ctx2) {}
}

export class MainContext extends BaseContext<MainContext> implements Ctx1, Ctx2 {
  constructor(public config: Config1 & Config2) {
    super();
  }

  protected override getThis(): MainContext {
    return this;
  }
}

const ctx1: Ctx1 = new MainContext({ a: 42, b: 'abc' });
