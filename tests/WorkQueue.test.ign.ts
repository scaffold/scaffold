import { assert, assertEquals } from 'std-latest/testing/asserts.ts';
import { Hash } from '../src/util/Hash.ts';
import { makeTest } from './util.ts';
import { WorkQueue } from '../../sbl/WorkQueue.ts';

Deno.test(
  { name: `WorkQueue test start workers` },
  makeTest({ initialWorkerCount: 0 }, async (ctx) => {
    let isComplete = false;
    ctx.get(WorkQueue).set(Hash.digest('a'), 1, () =>
      new Promise((resolve) => {
        isComplete = true;
        resolve();
      }));
    await Promise.resolve();
    assertEquals(isComplete, false);

    ctx.get(WorkQueue).setWorkerCount(4);
    await Promise.resolve();
    assertEquals(isComplete, true);

    await ctx.get(WorkQueue).setWorkerCount(0);
  }),
);

Deno.test(
  { name: `WorkQueue test parallelism` },
  makeTest({ initialWorkerCount: 0 }, async (ctx) => {
    let running = 0;
    let remaining = 0;
    for (let i = 0; i < 100; i++) {
      remaining++;
      ctx.get(WorkQueue).set(
        Hash.digest(`${i}`),
        Math.random(),
        () =>
          new Promise((resolve) => {
            running++;
            assert(running <= ctx.get(WorkQueue).getTargetWorkerCount());
            setTimeout(() => {
              running--;
              remaining--;
              resolve();
            }, Math.random() * 10);
          }),
      );
    }

    ctx.get(WorkQueue).setWorkerCount(4);

    while (remaining) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      ctx.get(WorkQueue).setWorkerCount(Math.floor(Math.random() * 10));
    }

    await ctx.get(WorkQueue).setWorkerCount(0);
  }),
);
