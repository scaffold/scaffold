import { mapPut } from './map.ts';

export type SamplerState = number;

export abstract class RandomSampler<
  T extends object | symbol, /* { samplerState: SamplerState } */
> {
  private indices = new Map<T, number>();
  private heap: (T | number)[] = [];

  protected abstract weight(item: T): number;

  public getAll() {
    return this.indices.keys();
  }

  public increaseWeight(item: T) {
    mapPut(this.indices, item, () => {
      const idx = this.heap.length;
      const branchIdx = idx >>> 1;
      const mv = this.heap[branchIdx] as T;
      this.heap.push(mv, item);
      if (mv !== undefined) {
        this.indices.set(mv, idx);
      }
      this.updateHeap(branchIdx);
      return idx + 1;
    }, (idx) => {
      if (this.heap[idx] !== item) {
        throw new Error(`Heap doesn't match map at index ${idx}`);
      }
      this.updateHeap(idx >>> 1);
      return idx;
    });
    this.countHeapViolations();
  }

  public sample(): { item: T; weight: number } | undefined {
    if (this.heap.length < 2) {
      return;
    } else if (this.heap.length === 2) {
      return { item: this.heap[1] as T, weight: 1 };
    }

    const total = this.heap[1] as number;
    if (total <= 0) {
      return;
    }

    let offset = total * Math.random();
    let idx = 1;
    let a: T | number;
    while (true) {
      idx <<= 1;
      a = this.heap[idx];
      if (typeof a !== 'number') {
        break;
      }
      if (offset >= a) {
        offset -= a;
        idx++;
      }
    }

    if (a !== undefined) {
      const aWeight = this.weight(a);
      const b = this.heap[idx + 1] as T;
      const bWeight = this.weight(b);
      // TODO: Check for zero weight here
      this.heap[idx >>> 1] = aWeight + bWeight;
      this.updateHeap(idx >>> 2);
      this.countHeapViolations();
      if (offset < aWeight) {
        return { item: a, weight: aWeight / total };
      } else if (offset < aWeight + bWeight) {
        return { item: b, weight: bWeight / total };
      } else {
        return this.sample();
      }
    } else {
      if (idx !== this.heap.length || (idx & 3) !== 2) {
        throw new Error(`Internal error!`);
      }
      idx >>>= 1;

      const aWeight = this.heap[idx - 1] as number;
      const b = this.heap[idx] as T;
      const bWeight = this.weight(b);
      // TODO: Check for zero weight here
      this.heap[idx >>> 1] = aWeight + bWeight;
      this.updateHeap(idx >>> 2);
      this.countHeapViolations();
      if (offset < bWeight) {
        return { item: b, weight: bWeight / total };
      } else {
        return this.sample();
      }
    }
  }

  public cleanup() {
    if (this.heap.length < 16 || this.estimateZeroRatio() < 0.25) {
      return;
    }

    // Remove zero-weight branches
  }

  public estimateZeroRatio() {
    const s = this.heap.length >>> 1;
    let countZeros = 0;
    for (let i = 1; i < s; i++) {
      if (this.heap[i] === 0) {
        countZeros++;
      }
    }
    return Math.sqrt(countZeros / (s - 1));
  }

  public getSize() {
    return this.heap.length >>> 1;
  }

  public countHeapViolations() {
    const size = this.indices.size;
    if (this.heap.length !== size * 2) {
      throw new Error(`Heap size property violated!`);
    }

    for (let i = 1; i < size; i++) {
      if (typeof this.heap[i] !== 'number') {
        throw new Error(`Heap branch type property violated!`);
      }
    }

    for (let i = size; i < this.heap.length; i++) {
      if (
        typeof this.heap[i] !== 'object' && typeof this.heap[i] !== 'symbol'
      ) {
        throw new Error(`Heap leaf type property violated!`);
      }
      if (this.indices.get(this.heap[i] as T) !== i) {
        throw new Error(`Heap indexer property violated!`);
      }
    }

    let violations = 0;
    for (let i = 1; i < size; i++) {
      const a = this.heap[i << 1];
      const b = this.heap[(i << 1) + 1];
      if (
        typeof a === 'number' && typeof b === 'number' && this.heap[i] !== a + b
      ) {
        throw new Error(`Heap sum property violated!`);
      } else if (
        this.heap[i] as number < (typeof a === 'number' ? a : this.weight(a)) +
            (typeof b === 'number' ? b : this.weight(b))
      ) {
        violations++;
      }
    }

    return violations;
  }

  private updateHeap(idx: number) {
    for (let i = idx; i !== 0; i >>>= 1) {
      const a = this.heap[i << 1];
      const b = this.heap[(i << 1) + 1];
      this.heap[i] = (typeof a === 'number' ? a : this.weight(a)) +
        (typeof b === 'number' ? b : this.weight(b));
    }
  }
}
