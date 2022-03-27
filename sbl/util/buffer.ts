export const arrEquals = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
};

export const arrConcat = (...arrs: Uint8Array[]) => {
  const lengthSum = arrs.reduce((acc, cur) => acc + cur.length, 0);
  const arr = new Uint8Array(lengthSum);
  arrs.reduce((acc, cur) => {
    arr.set(cur, acc);
    return acc + cur.length;
  }, 0);
  return arr;
};

export const fromNumber = (num: number, bytes: number) => {
  const arr = [];
  for (let i = 0; i < bytes; i++) {
    arr.push(num & 0xFF);
    num >>= 8;
  }
  return new Uint8Array(arr);
};
