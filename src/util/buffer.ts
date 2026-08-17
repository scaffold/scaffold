import * as bytes from '@std/bytes';
import { once } from './functional.ts';
import { bin2hex } from './hex.ts';

export const EMPTY_ARR = new Uint8Array();

export const isAscii = (bin: Uint8Array) => bin.every((x) => x >= 32 && x < 127);

const decoder = new TextDecoder();
export const bin2str = once((bin: Uint8Array): string => decoder.decode(bin));

const encoder = new TextEncoder();
export const str2bin = (str: string): Uint8Array => encoder.encode(str);

export const arrEquals = (a: Uint8Array, b: Uint8Array) => a === b || bytes.equals(a, b);

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

export const arrConcat = (...arrs: Uint8Array[]) => bytes.concat(arrs);

export const arrFromNumber = (num: number, bytes: number) => {
  const arr = [];
  for (let i = 0; i < bytes; i++) {
    arr.push(num & 0xFF);
    num >>= 8;
  }
  return new Uint8Array(arr);
};

export const bin2prim = bin2hex;
