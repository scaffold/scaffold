import { Hash } from './Hash.ts';

export const jsonSafeStringify = (obj: unknown, space?: number) => {
  const ancestors: unknown[] = [];
  return JSON.stringify(obj, function (_key, val) {
    switch (typeof val) {
      case 'bigint':
        return val.toString();
      case 'object':
        if (val === null) {
          return null;
        } else if ('hash' in val && val.hash instanceof Hash) {
          return { hash: val.hash.toHex() };
        } else if (val instanceof Hash) {
          return val.toHex();
        } else {
          while (ancestors.length > 0 && ancestors.at(-1) !== this) {
            ancestors.pop();
          }
          if (ancestors.includes(val)) {
            return '[circular]';
          } else {
            ancestors.push(val);
            return val;
          }
        }
      default:
        return val;
    }
  }, space);
};
