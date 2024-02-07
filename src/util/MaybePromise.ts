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

export const raceTruthy = <T>(
  cb: (until: AbortSignal) => MaybePromise<T>[],
  until: AbortSignal,
) => {
  if (until.aborted) {
    return;
  }

  const controller = new AbortController();
  until.addEventListener('abort', () => controller.abort());

  const promises = cb(controller.signal);
  let count = promises.length;
  if (count === 0) {
    return;
  }

  return new Promise<T | undefined>((resolve) => {
    for (const promise of promises) {
      maybeThen(promise, (val) => {
        if (val) {
          controller.abort();
          resolve(val);
        } else if (--count === 0) {
          resolve(undefined);
        }
      });
    }
  });
};
