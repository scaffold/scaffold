import { Config } from './Config.ts';

export class Context {
  private objs = new Map<{ new (context: Context): unknown }, unknown>();
  private destructors: (() => Promise<void> | void)[] = [];
  private isDestructed = false;

  constructor(public config: Config) {
    // This is for debugging
    // TODO: Remove
    (window as any).ctx = this;
    (window as any).get = (match: string) => {
      match = match.toLowerCase();
      const candidates = [...this.objs.entries()].filter(([{ name }]) =>
        name.toLowerCase().includes(match)
      );
      if (candidates.length !== 1) {
        throw new Error(
          `Not exactly one candidate module: ${
            JSON.stringify(candidates.map(([{ name }]) => name))
          }`,
        );
      }
      return candidates[0][1];
    };
  }

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

  public onDestruct(cb: () => Promise<void> | void) {
    this.destructors.push(cb);
  }

  public debugGetAll() {
    return this.objs;
  }
}
