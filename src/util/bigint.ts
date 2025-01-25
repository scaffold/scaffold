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

export const bin2bigint = (arr: Uint8Array) => {
  let res = 0n;
  for (let i = 0; i < arr.byteLength; i++) {
    res |= BigInt(arr[i]) << BigInt(i << 3);
  }
  return res;
};

export const bigint2bin = (num: bigint, size?: number) => {
  if (num < 0n) {
    throw new Error(`Cannot convert a negative bigint to binary!`);
  }

  if (size !== undefined) {
    const arr = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      arr[i] = Number(num & 0xFFn);
      num >>= 8n;
    }
    if (num !== 0n) {
      throw new Error(`Bigint exceeds ${size} bytes!`);
    }
    return arr;
  } else {
    const arr: number[] = [];
    while (num !== 0n) {
      arr.push(Number(num & 0xFFn));
      num >>= 8n;
    }
    return new Uint8Array(arr);
  }
};
