import { memoize } from './functional.ts';

const bin2hexLut = Array.from(
  { length: 256 },
  (_, i) => i.toString(16).padStart(2, '0'),
);
export const bin2hex = memoize((arr: Uint8Array): string => {
  // return Array.from(this.digest).map((b) => b.toString(16).padStart(2, '0')).join('');
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    out += bin2hexLut[arr[i]];
  }
  return out;
});

export const hex2bin = (hex: string): Uint8Array => {
  if (hex.length & 1) {
    throw new Error(`Invalid hex string; not an even length`);
  }
  // return new Uint8Array((hex.match(/.{1,2}/g) || []).map((byte) => parseInt(byte, 16)));
  const res = new Uint8Array(hex.length >>> 1);
  for (let i = 0; i < res.length; i++) {
    res[i] = parseInt(hex.substr(i << 1, 2), 16);
  }
  return res;
};
