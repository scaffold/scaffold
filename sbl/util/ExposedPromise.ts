export default class ExposedPromise<T> extends Promise<T> {
  public resolve: (value: T) => void = () => {
    throw new Error(`Should never be called`);
  };
  public reject: (err: any) => void = () => {
    throw new Error(`Should never be called`);
  };

  private constructor() {
    super(() => {});
    throw new Error(`Don't use this constructor`);
  }

  static get [Symbol.species]() {
    return Promise;
  }

  public static create<T>(): ExposedPromise<T> {
    let resolve: (value: T | PromiseLike<T>) => void;
    let reject: (reason: any) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    }) as ExposedPromise<T>;
    promise.resolve = resolve!;
    promise.reject = reject!;
    return promise;
  }
}
