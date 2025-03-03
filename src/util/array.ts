import { assert } from './functional.ts';

export const arrRemove = <T>(arr: T[], value: T) => {
  const idx = arr.indexOf(value);
  assert(idx !== -1);
  arr.splice(idx, 1);
};
