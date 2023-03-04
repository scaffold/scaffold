import { assertEquals } from 'std-latest/testing/asserts.ts';
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
  makeTest({}, async () => {
    const beginTime = Date.now();

    const st = new StateTracker<Key, State>((
      key: Key,
      onState: (state: State) => void,
    ) => {
      // The system is able to produce answers after this value:
      if (key.idx >= 10000) {
        const triggerTime = beginTime + Number(key.idx - 20000n);
        const waitTime = Math.max(0, triggerTime - Date.now());
        const timeout = setTimeout(
          () => onState({ value: Number(key.idx) }),
          Math.min(waitTime, 1e6),
        );
        return {
          release: () => clearTimeout(timeout),
        };
      } else {
        return {
          release: () => {},
        };
      }
    });

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
    await waitFor((idx) => idx > 20100n);

    // Make sure we get some specific indices
    await waitFor((idx) => idx === 20200n);
    await waitFor((idx) => idx === 20207n);
    await waitFor((idx) => idx === 20270n);
    await waitFor((idx) => idx === 20277n);

    await tracker.release();
  }),
);
