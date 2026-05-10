import { BaseContext } from '../util/BaseContext.ts';

interface CoreConfig {
  a: number;
}

interface CoreContext extends BaseContext {
  config: CoreConfig;
}

// export class MainContext extends BaseContext implements Ctx1, Ctx2 {
//   constructor(public config: Config1 & Config2) {
//     super();
//   }
// }

// new MainContext({ a: 42, b: 'abc' }).get(X);
