import Hash from './util/Hash.ts';

export const arrayAccumulator = [
  <T>(_hash: Hash, arr: T[] | undefined, val: T) =>
    arr !== undefined ? [...arr, val] : [val],
  <T>(_hash: Hash, arr: T[] | undefined, val: T) => {
    arr = arr!.filter((x) => x !== val);
    return arr.length ? arr : undefined;
  },
] as const;
export const amountAccumulator = [
  <T extends { amount: bigint }>(_hash: Hash, acc: T | undefined, val: T) =>
    acc !== undefined ? { ...acc, amount: acc.amount + val.amount } : val,
  <T extends { amount: bigint }>(
    _hash: Hash,
    acc: T | undefined,
    val: T,
  ) => ({ ...acc!, amount: acc!.amount - val.amount }),
] as const;
export const bigintAccumulator = [
  (_hash: Hash, acc: bigint | undefined, amount: bigint) =>
    acc !== undefined ? acc + amount : amount,
  (_hash: Hash, acc: bigint | undefined, amount: bigint) => acc! - amount,
] as const;
