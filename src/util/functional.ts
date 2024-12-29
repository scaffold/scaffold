export { assert, unimplemented as todo } from '@std/assert';

// deno-lint-ignore ban-types
export type NotUndefined = {} | null;

export const error = (msg: string): never => {
  throw new Error(msg);
};

export const neverPromise = new Promise<never>(() => {});

export const match = <T, R>(
  val: T | undefined,
  ifTruthy: (val: T) => R,
  ifUndef: () => R,
) => {
  if (val !== undefined) {
    return ifTruthy(val);
  } else {
    return ifUndef();
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

export const mapEntries = <K extends string | number | symbol, V1, V2>(
  obj: Record<K, V1>,
  func: (k: K, v: V1) => V2,
): Record<K, V2> =>
  Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, func(k as K, v as V1)]),
  ) as Record<K, V2>;

export const mapOne = <T, R>(
  arr: T[],
  func: (el: T, idx: number, arr: T[]) => R | undefined,
): R | undefined => {
  let res: R | undefined;
  for (const c of arr.map(func)) {
    if (c !== undefined) {
      if (res !== undefined) {
        throw new Error(`More than one element mapped to a truthy value!`);
      }
      res = c;
    }
  }
  return res;
};

export const range = (size: number) => Array.from({ length: size }, (_, i) => i);
