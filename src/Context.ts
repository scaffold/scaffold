import { Config } from './Config.ts';
import { MaybePromise } from './util/MaybePromise.ts';

export class Context {
  private objs = new Map<{ new (context: Context): unknown }, unknown>();
  private destructors: (() => MaybePromise<void>)[] = [];
  private isDestructed = false;

  constructor(public config: Config) {}

  public destruct(): MaybePromise<void> {
    if (this.isDestructed) {
      throw new Error(`Cannot destruct a context twice!`);
    }
    const results = this.destructors.reverse().map((cb) => cb());
    results.push(this.config.storageProvider.close());
    if (results.some((x) => x instanceof Promise)) {
      return Promise.all(results).then(() => this.reset());
    } else {
      this.reset();
    }
  }

  public get<T>(Type: { new (context: Context): T }): T {
    if (!this.objs.has(Type)) {
      if (this.isDestructed) {
        throw new Error(`Cannot use a context after it's been destructed!`);
      }

      this.objs.set(Type, null);
      // First set it to null, so if the constructor recursively calls itself inside the following line, we'll know.
      this.objs.set(Type, new Type(this));
    }

    const res = this.objs.get(Type);
    if (res === null) {
      throw new Error(`Constructor for ${Type.name} is probably recursive`);
    }

    return res as T;
  }

  public maybeGet<T>(Type: { new (context: Context): T }): T | undefined {
    return this.objs.get(Type) as T | undefined;
  }

  public onDestruct(cb: () => MaybePromise<void>) {
    this.destructors.push(cb);
  }

  public debugGetAll() {
    return this.objs;
  }

  private reset() {
    this.objs = new Map();
    this.destructors = [];
    this.isDestructed = true;
  }
}
