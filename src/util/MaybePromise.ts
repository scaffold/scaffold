export type MaybePromise<T> = T | Promise<T>;

// Resolves synchronously if it's a concrete value, and asynchronously if it's a promise.
export const maybeThen = <T, R>(
  p: MaybePromise<T>,
  cb: (t: T) => R,
): MaybePromise<R> => {
  if (p instanceof Promise) {
    return p.then(cb);
  } else {
    return cb(p);
  }
};
