import { assert } from './functional.ts';

export const popcount = (n: number) => {
  assert(n <= 0xFFFFFFFF);
  n = n - ((n >> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >> 2) & 0x33333333);
  return ((n + (n >> 4) & 0xF0F0F0F) * 0x1010101) >> 24;
};

// Src gets filled into the zeros of mask. The ones of mask get set to zero.
export const bitScatter = (dst: Uint8Array, mask: Uint8Array, src: Uint8Array, offset: number = 0) => {
  for (let i = 0; i < mask.byteLength * 8; i++) {
    const m = mask[i >> 3] & (1 << (i & 7));
    if (!m) {
      dst[i >> 3] |= (src[offset >> 3] & (1 << (offset & 7)));
      offset++;
    }
  }
  return offset;
};
