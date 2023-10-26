export const arrEquals = (a: Uint8Array, b: Uint8Array) => {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
};

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
