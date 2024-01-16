import { equals } from 'std-latest/bytes/equals.ts';
import { concat } from 'std-latest/bytes/concat.ts';
import { memoize } from './functional.ts';

export const EMPTY_ARR = new Uint8Array();

export const bin2str = memoize((bin: Uint8Array): string =>
  new TextDecoder().decode(bin)
);
export const str2bin = (str: string): Uint8Array =>
  new TextEncoder().encode(str);

export const arrEquals = (a: Uint8Array, b: Uint8Array) =>
  a === b || equals(a, b);

export const arrCompare = (a: Uint8Array, b: Uint8Array) => {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] < b[i]) {
      return -1;
    } else if (a[i] > b[i]) {
      return 1;
    }
  }

  if (a.length < b.length) {
    return -1;
  } else if (a.length > b.length) {
    return 1;
  } else {
    return 0;
  }
};

export const arrConcat = (...arrs: Uint8Array[]) => concat(arrs);

export const arrFromNumber = (num: number, bytes: number) => {
  const arr = [];
  for (let i = 0; i < bytes; i++) {
    arr.push(num & 0xFF);
    num >>= 8;
  }
  return new Uint8Array(arr);
};
