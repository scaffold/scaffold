import { arrCall } from './array.ts';
import { assert } from './functional.ts';
import { mapPop, multimapPop, multimapPut } from './map.ts';
import { MaybePromise } from './MaybePromise.ts';

export interface MaybeDisposable {
  [Symbol.dispose]?(): void;
  [Symbol.asyncDispose]?(): Promise<void>;
}

export abstract class BaseContext {
  private objs = new Map<new (ctx: never) => unknown, unknown>();
  private constructing = new Set<new (ctx: never) => unknown>();

  private listeners = new Map<new (ctx: never) => unknown, ((ctx: object) => void)[]>();

  // TODO: AsyncDisposableStack
  private destructors: (() => MaybePromise<void>)[] = [];
  private isDestructed = false;

  public destruct(): MaybePromise<void> {
    if (this.isDestructed) {
      throw new Error(`Cannot destruct a context twice!`);
    }
    this.isDestructed = true;
    const results = this.destructors.toReversed().map((cb) => cb());
    if (results.some((x) => x instanceof Promise)) {
      return Promise.all(results).then(() => this.reset());
    } else {
      this.reset();
    }
  }

  public get<T extends object & MaybeDisposable>(Type: new (ctx: this) => T): T {
    if (!this.objs.has(Type)) {
      if (this.isDestructed) {
        throw new Error(`Cannot use a context after it's been destructed!`);
      }

      // Catch recursive constructors
      if (this.constructing.has(Type)) {
        throw new Error(`Constructor for ${Type.name} is probably recursive`);
      }
      this.constructing.add(Type);

      let obj;
      try {
        obj = new Type(this);
        this.objs.set(Type, obj);
      } finally {
        this.constructing.delete(Type);
      }

      const disposer = obj[Symbol.dispose];
      if (disposer !== undefined) {
        this.destructors.push(disposer.bind(obj));
      }

      const asyncDisposer = obj[Symbol.asyncDispose];
      if (asyncDisposer !== undefined) {
        this.destructors.push(asyncDisposer.bind(obj));
      }

      const listeners = mapPop(this.listeners, Type);
      if (listeners !== undefined) arrCall(listeners, [obj]);
    }

    return this.objs.get(Type) as T;
  }

  public maybeGet<T>(Type: new (ctx: this) => T): T | undefined {
    return this.objs.get(Type) as T | undefined;
  }

  public onConstruct<T extends object & MaybeDisposable>(
    Type: new (ctx: this) => T,
    cb: (obj: T) => void,
    signal: AbortSignal,
  ) {
    if (signal.aborted) return;
    const obj = this.maybeGet(Type);
    if (obj !== undefined) {
      cb(obj);
    } else {
      multimapPut(this.listeners, Type, cb);
      signal.addEventListener('abort', () => multimapPop(this.listeners, Type, cb));
    }
  }

  public debugGetAll() {
    return this.objs;
  }

  public mock<T extends object & MaybeDisposable>(
    Type: new (ctx: this) => T,
    mock: T,
  ): void {
    if (this.objs.has(Type)) {
      throw new Error(`Cannot mock ${Type.name} after it's been constructed!`);
    }

    this.objs.set(Type, mock);
  }

  /** Override the defaults of a config class. The zero-arg constructor is what
   * distinguishes config from a service, which always takes a ctx.
   * Patches merge, and stay visible after a consumer has read the config -- so
   * consumers must hold the config object and read fields lazily, never copy
   * them into their own state at construction. */
  public configure<T extends object>(Type: new () => T, patch: Partial<T>): void {
    Object.assign(this.get(Type), patch);
  }

  private reset() {
    assert(this.isDestructed);
    assert(this.constructing.size === 0);
    this.objs = new Map();
    this.destructors = [];
  }
}
