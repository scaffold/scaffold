const NEVER: () => void = () => {
  throw new Error(`This should never be called!`);
};

export default class StateTracker<Key, State> {
  constructor(
    private getter: (
      key: Key,
      onState: (state: State) => void,
    ) => { release(): void },
  ) {}

  public track(
    questionFactory: (idx: bigint) => Key,
    onState: (idx: bigint, state: State) => void,
    opts: {
      // The initial index to start testing at.
      initIdx?: bigint;

      // The number of ticks in the future to subscribe to.
      futureSubCount?: bigint;

      // The number of evenly-spaced subscriptions to place when trying to narrow down the current index.
      narrowingSubCount?: bigint;

      // The number of milliseconds to wait before unsubscribing from a tick.
      unsubWaitMs?: number;

      // The maximum subscription, log2
      maxSubLog2?: bigint;
    } = {},
  ) {
    const {
      initIdx,
      futureSubCount,
      narrowingSubCount,
      unsubWaitMs,
      maxSubLog2,
    } = Object.assign({
      initIdx: 0n,
      futureSubCount: 100n,
      narrowingSubCount: 16n,
      unsubWaitMs: 10000,
      maxSubLog2: 63n,
    }, opts);

    let subs: { idx: bigint; lastAnswerTime: number; release(): void }[] = [];
    const listeningIdxs: Set<bigint> = new Set();

    const addSub = (idx: bigint) => {
      if (listeningIdxs.has(idx)) {
        return;
      }
      listeningIdxs.add(idx);

      console.log('StateTracker LISTENING TO', idx, subs.map(({ idx }) => idx));

      const sub = { idx, lastAnswerTime: Infinity, release: NEVER };
      sub.release = this.getter(
        questionFactory(idx),
        (state) => {
          onState(idx, state);
          sub.lastAnswerTime = Date.now();

          let nextSub = finalSub;
          subs.forEach((sub) => {
            if (sub.idx > idx && sub.idx < nextSub.idx) {
              nextSub = sub;
            }
          });
          if (nextSub.lastAnswerTime === Infinity) {
            const subSpan = nextSub.idx - idx;
            if (subSpan > futureSubCount) {
              for (let i = narrowingSubCount - 1n; i >= 1n; i--) {
                const addIdx = idx + subSpan * i / narrowingSubCount;
                addSub(addIdx);
              }
            } else {
              for (let i = futureSubCount; i >= 1n; i--) {
                addSub(idx + i);
              }
            }
          }
        },
      ).release;

      const r = sub.release;
      sub.release = () => {
        console.log('StateTracker UNSUB FROM', idx);
        r();
      };

      subs.push(sub);
      return sub;
    };

    const finalSub = addSub((1n << maxSubLog2) - 1n)!;

    for (let i = maxSubLog2; i-- > 0n;) {
      const idx = initIdx + (1n << i);
      if (idx >= 0n) {
        addSub(idx);
      }
    }
    addSub(initIdx);
    for (let i = 0n; i < maxSubLog2; i++) {
      const idx = initIdx - (1n << i);
      if (idx >= 0n) {
        addSub(idx);
      }
    }

    const itvl = setInterval(() => {
      const threshold = Date.now() - unsubWaitMs;
      subs = subs.filter((sub) => {
        if (sub.lastAnswerTime > threshold) {
          return true;
        } else {
          sub.release();
          listeningIdxs.delete(sub.idx);
          return false;
        }
      });
      // while (subs.length) {
      //   const last = subs[subs.length - 1];
      //   if (last.lastAnswerTime < threshold) {
      //     const sub = subs.pop()!;
      //     sub.release();
      //     listeningIdxs.delete(sub.idx);
      //   } else {
      //     break;
      //   }
      // }
    }, 1000);

    return {
      release: () => {
        console.log('StateTracker BIG RELEASE');
        clearInterval(itvl);
        subs.forEach((sub) => sub.release());
      },
    };
  }
}
