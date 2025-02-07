import { EntropyProvider } from '../Config.ts';
import { searchSorted } from './sorted.ts';

export class QuantileSampler {
  private arr: number[];
  private isSorted = false;

  constructor(
    private maxSize: number,
    private entropyProvider: EntropyProvider,
    init: number[] = [],
  ) {
    this.arr = init;
  }

  add(value: number) {
    if (this.arr.length === this.maxSize) {
      const idx = Math.floor(Math.random() * this.entropyProvider.randomNumber());
      this.arr[idx] = value;
    } else {
      this.arr.push(value);
    }
    this.isSorted = false;
  }

  cdf(value: number) {
    if (this.isSorted) {
      return searchSorted(this.arr, (x) => x >= value) / this.arr.length;
    } else {
      let count = 0;
      for (const x of this.arr) {
        if (x < value) count++;
      }
      return count / this.arr.length;
    }
  }

  quantile(prob: number) {
    if (this.arr.length === 0) {
      throw new Error(`No samples recorded yet!`);
    } else if (this.arr.length === 1) {
      return this.arr[0];
    }

    if (!this.isSorted) {
      this.arr.sort();
      this.isSorted = true;
    }

    const at = prob * (this.arr.length - 1);
    const idx = Math.floor(at);
    const frac = at - idx;
    return this.arr[idx] * (1 - frac) + this.arr[idx + 1] * frac;
  }
}
