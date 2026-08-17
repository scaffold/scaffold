import { assert } from '@std/assert';

export { assert, assertEquals, unimplemented as todo } from '@std/assert';

// deno-lint-ignore ban-types
export type NotUndefined = {} | null;

export function error(msg: string): never {
  throw new Error(msg);
}

export const neverPromise = new Promise<never>(() => {});

const undefKey = Symbol('undefKey');
export function once<R>(fn: () => R): () => R;
export function once<This extends WeakKey, R>(fn: (this: This) => R): (this: This) => R;
export function once<Arg extends WeakKey, R>(fn: (arg: Arg) => R): (arg: Arg) => R;
export function once(fn: (this: unknown, arg?: WeakKey) => unknown) {
  const cache = new WeakMap<WeakKey, unknown>();
  return function (this: WeakKey | undefined, arg?: WeakKey) {
    assert(this === undefined || arg === undefined, 'once: keyed on a receiver and an argument');
    const key = arg ?? this ?? undefKey;
    if (!cache.has(key)) cache.set(key, fn.call(this, arg));
    return cache.get(key);
  };
}

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
