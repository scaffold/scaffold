import { assert } from '~/sbl/util/functional.ts';

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

export const bigint2bin = (num: bigint, size: number) => {
  const arr = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    arr[i] = Number(num & 0xFFn);
    num >>= 8n;
  }
  return arr;
};

const t = 13473837727108541341n;
assert(bin2bigint(bigint2bin(t, 8)) === t);
