import { assert } from './functional.ts';
import { MaybePromise } from './MaybePromise.ts';

export interface MaybeDisposable {
  [Symbol.dispose]?(): void;
  [Symbol.asyncDispose]?(): Promise<void>;
}

export interface ContextProvider {
  get<T extends object & MaybeDisposable>(Type: new (ctx: this) => T): T;

  maybeGet<T>(Type: new (ctx: this) => T): T | undefined;

  onDestruct(cb: () => MaybePromise<void>): void;

  mock<T extends object & MaybeDisposable>(
    Type: new (ctx: this) => T,
    mock: T,
  ): void;
}

export abstract class BaseContext<DerivedType> {
  private objs = new Map<{ new (context: DerivedType): unknown }, unknown>();
  private constructing = new Set<{ new (context: DerivedType): unknown }>();
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

  public get<T extends object & MaybeDisposable>(Type: { new (context: DerivedType): T }): T {
    if (!this.objs.has(Type)) {
      if (this.isDestructed) {
        throw new Error(`Cannot use a context after it's been destructed!`);
      }

      // Catch recursive constructors
      if (this.constructing.has(Type)) {
        throw new Error(`Constructor for ${Type.name} is probably recursive`);
      }
      this.constructing.add(Type);

      try {
        const obj = new Type(this.getThis());
        this.objs.set(Type, obj);

        const disposer = obj[Symbol.dispose];
        if (disposer !== undefined) {
          this.destructors.push(disposer.bind(obj));
        }

        const asyncDisposer = obj[Symbol.asyncDispose];
        if (asyncDisposer !== undefined) {
          this.destructors.push(asyncDisposer.bind(obj));
        }
      } finally {
        this.constructing.delete(Type);
      }
    }

    return this.objs.get(Type) as T;
  }

  public maybeGet<T>(Type: { new (context: DerivedType): T }): T | undefined {
    return this.objs.get(Type) as T | undefined;
  }

  public onDestruct(cb: () => MaybePromise<void>) {
    this.destructors.push(cb);
  }

  public debugGetAll() {
    return this.objs;
  }

  protected abstract getThis(): DerivedType;

  protected mock<T extends object & MaybeDisposable>(
    Type: { new (context: DerivedType): T },
    mock: T,
  ): void {
    if (this.objs.has(Type)) {
      throw new Error(`Cannot mock ${Type.name} after it's been constructed!`);
    }

    this.objs.set(Type, mock);
  }

  private reset() {
    assert(this.isDestructed);
    assert(this.constructing.size === 0);
    this.objs = new Map();
    this.destructors = [];
  }
}
