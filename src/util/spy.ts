import { Timeout } from '../interfaces/TimeProvider.ts';

export const watchClass = (cls: any, watchKeys: string[], then: () => void) => {
  let timeout: Timeout | undefined;
  for (const key of watchKeys) {
    const orig = cls[key];
    if (orig instanceof Function) {
      cls[key] = (...args: unknown[]) => {
        if (timeout === undefined) {
          timeout = setTimeout(() => {
            timeout = undefined;
            then();
          }, 0);
        }
        return orig.apply(cls, args);
      };
    } else {
      throw new Error(`Key ${key} does not exist in class ${cls}!`);
    }
  }
};
