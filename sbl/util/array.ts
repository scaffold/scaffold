export const arrPut = <V>(
  arr: V[],
  idx: number,
  creator: (idx: number) => V,
  mutator?: (v: V) => V,
) => {
  while (arr.length <= idx) {
    arr.push(creator(arr.length));
  }
  if (mutator !== undefined) {
    const val = mutator(arr[idx]);
    arr[idx] = val;
    return val;
  } else {
    return arr[idx];
  }
};
