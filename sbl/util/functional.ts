export const error = (msg: string): never => {
  throw new Error(msg);
};

export const assert = (cond: boolean, msg?: string) => {
  if (!cond) {
    throw new Error(msg);
  }
};

export const memoize = <ArgType extends Object, ReturnType>(
  func: (arg: ArgType) => ReturnType,
) => {
  const cache = new WeakMap<ArgType, ReturnType>();
  return (arg: ArgType): ReturnType => {
    let res = cache.get(arg);
    if (!res) {
      res = func(arg);
      cache.set(arg, res);
    }
    return res!;
  };
};
