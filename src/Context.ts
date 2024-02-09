import { Config } from './Config.ts';

export class Context {
  private objs = new Map<{ new (context: Context): unknown }, unknown>();
  private destructors: (() => Promise<void> | void)[] = [];
  private isDestructed = false;

  constructor(public config: Config) {}

  public async destruct() {
    if (this.isDestructed) {
      throw new Error(`Cannot destruct a context twice!`);
    }
    await Promise.all(this.destructors.reverse().map((cb) => cb()));
    await this.config.storageProvider.close();
    this.objs = new Map();
    this.destructors = [];
    this.isDestructed = true;
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

  public onDestruct(cb: () => Promise<void> | void) {
    this.destructors.push(cb);
  }

  public debugGetAll() {
    return this.objs;
  }
}
