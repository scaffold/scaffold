import { assert } from './functional.ts';
import { arrEquals } from './buffer.ts';

export const bigintMin = (a: bigint, b: bigint) => a < b ? a : b;
export const bigintMax = (a: bigint, b: bigint) => a > b ? a : b;

export const countTrailingZeros = (num: bigint) => {
  if (num <= 0n) {
    throw new Error(`Must be positive: ${num}!`);
  }
  // TODO: Optimize
  const str = num.toString(2);
  return str.length - 1 - str.lastIndexOf('1');
};

assert(countTrailingZeros(5n) === 0);
assert(countTrailingZeros(6n) === 1);
assert(countTrailingZeros(8n) === 3);

export const bin2bigint = (arr: Uint8Array) => {
  let res = 0n;
  for (let i = 0; i < arr.byteLength; i++) {
    res |= BigInt(arr[i]) << BigInt(i << 3);
  }
  return res;
};

export const bigint2bin = (num: bigint, size?: number) => {
  if (size) {
    const arr = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      arr[i] = Number(num & 0xFFn);
      num >>= 8n;
    }
    return arr;
  } else {
    const arr: number[] = [];
    while (num > 0n) {
      arr.push(Number(num & 0xFFn));
      num >>= 8n;
    }
    return new Uint8Array(arr);
  }
};

assert(bin2bigint(new Uint8Array([])) === 0n);
assert(bin2bigint(new Uint8Array([7])) === 7n);
assert(bin2bigint(new Uint8Array([255])) === 255n);
assert(bin2bigint(new Uint8Array([0, 1])) === 256n);
assert(bin2bigint(new Uint8Array([7, 1])) === 263n);

assert(arrEquals(bigint2bin(0n), new Uint8Array([])));
assert(arrEquals(bigint2bin(7n), new Uint8Array([7])));
assert(arrEquals(bigint2bin(255n), new Uint8Array([255])));
assert(arrEquals(bigint2bin(256n), new Uint8Array([0, 1])));
assert(arrEquals(bigint2bin(263n), new Uint8Array([7, 1])));

const t = 13473837727108541341n;
assert(bin2bigint(bigint2bin(t, 8)) === t);
