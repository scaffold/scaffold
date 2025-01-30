import { assert } from '@std/assert/assert';
import { MaybePromise } from './util/MaybePromise.ts';

export abstract class BaseContext<DerivedType> {
  private objs = new Map<{ new (context: DerivedType): unknown }, unknown>();
  private constructing = new Set<{ new (context: DerivedType): unknown }>();
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

  public get<T>(Type: { new (context: DerivedType): T }): T {
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
        this.objs.set(Type, new Type(this.getThis()));
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

  private reset() {
    assert(this.isDestructed);
    assert(this.constructing.size === 0);
    this.objs = new Map();
    this.destructors = [];
  }
}
