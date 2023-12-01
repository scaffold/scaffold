import { assertEquals } from 'std-latest/assert/mod.ts';
import { makeTest } from './util.ts';
import StateTracker from '~/sbl/util/StateTracker.ts';

interface Key {
  idx: bigint;
}
interface State {
  value: number;
}

Deno.test(
  { name: `StateTracker test` },
  makeTest({}, async (_testCtx, ctx) => {
    const beginTime = ctx.config.timeProvider.now();

    const st = new StateTracker<Key, State>((
      key: Key,
      onState: (state: State) => void,
    ) => {
      // The system is able to produce answers after this value:
      if (key.idx >= 100) {
        const triggerTime = beginTime + Number(key.idx - 200n);
        const waitTime = Math.max(
          0,
          triggerTime - ctx.config.timeProvider.now(),
        );
        const timeout = ctx.config.timeProvider.setTimeout(
          () => onState({ value: Number(key.idx) }),
          Math.min(waitTime, 1e6),
        );

        return {
          release: () => ctx.config.timeProvider.clearTimeout(timeout),
        };
      } else {
        return {
          release: () => {},
        };
      }
    }, ctx.config.timeProvider);

    const onIdx: ((idx: bigint) => void)[] = [];
    const waitFor = (filter: (idx: bigint) => boolean) =>
      new Promise<void>((resolve) =>
        onIdx.push((idx) => filter(idx) && resolve())
      );

    const tracker = st.track(
      (idx) => ({ idx }),
      (idx: bigint, state: State) => {
        assertEquals(Number(idx), state.value);
        onIdx.forEach((cb) => cb(idx));
      },
    );

    // Wait for state to sync
    await waitFor((idx) => idx > 300n);

    // Make sure we get some specific indices
    await waitFor((idx) => idx === 310n);
    await waitFor((idx) => idx === 317n);
    await waitFor((idx) => idx === 324n);
    await waitFor((idx) => idx === 350n);

    await tracker.release();
  }),
);
