import { assert } from '~/sbl/util/functional.ts';

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
