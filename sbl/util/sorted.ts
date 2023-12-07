import { assert } from '~/sbl/util/functional.ts';

// Returns the index of the first element where test(el) returns false
export const search = <T>(arr: T[], test: (x: T) => boolean) => {
  let i = 0;
  let j = arr.length;
  while (i < j) {
    const k = (i + j) >>> 1;
    if (test(arr[k])) {
      i = k + 1;
    } else {
      j = k;
    }
  }
  return i;
};

export const lowerBound = <T>(arr: T[], cmp: (x: T) => number) =>
  search(arr, (x) => cmp(x) > 0);
export const upperBound = <T>(arr: T[], cmp: (x: T) => number) =>
  search(arr, (x) => cmp(x) >= 0);

assert(lowerBound([1, 2, 4, 5, 5, 6], (x) => 0 - x) === 0);
assert(lowerBound([1, 2, 4, 5, 5, 6], (x) => 1 - x) === 0);
assert(lowerBound([1, 2, 4, 5, 5, 6], (x) => 2 - x) === 1);
assert(lowerBound([1, 2, 4, 5, 5, 6], (x) => 3 - x) === 2);
assert(lowerBound([1, 2, 4, 5, 5, 6], (x) => 4 - x) === 2);
assert(lowerBound([1, 2, 4, 5, 5, 6], (x) => 5 - x) === 3);
assert(lowerBound([1, 2, 4, 5, 5, 6], (x) => 6 - x) === 5);
assert(lowerBound([1, 2, 4, 5, 5, 6], (x) => 7 - x) === 6);

assert(upperBound([1, 2, 4, 5, 5, 6], (x) => 0 - x) === 0);
assert(upperBound([1, 2, 4, 5, 5, 6], (x) => 1 - x) === 1);
assert(upperBound([1, 2, 4, 5, 5, 6], (x) => 2 - x) === 2);
assert(upperBound([1, 2, 4, 5, 5, 6], (x) => 3 - x) === 2);
assert(upperBound([1, 2, 4, 5, 5, 6], (x) => 4 - x) === 3);
assert(upperBound([1, 2, 4, 5, 5, 6], (x) => 5 - x) === 5);
assert(upperBound([1, 2, 4, 5, 5, 6], (x) => 6 - x) === 6);
assert(upperBound([1, 2, 4, 5, 5, 6], (x) => 7 - x) === 6);
