import { MaybePromise, maybeThen } from './MaybePromise.ts';

export const neverAbort = new AbortController().signal;
// TODO: Are the abort callbacks garbage collected?
// We could make this a mock that just drops calls to addEventListener.

export const retryAbortable = <T>(
  cb: (until: AbortSignal) => MaybePromise<T>,
  until: AbortSignal,
  intervalMs = 100,
): MaybePromise<T> => {
  return new Promise<T>((resolve) => {
    if (until.aborted) {
      return;
    }

    let controller = new AbortController();
    until.addEventListener('abort', () => controller.abort());

    const loop = () => {
      maybeThen(cb(controller.signal), (value) => {
        controller.abort();
        resolve(value);
      });

      setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort();
          controller = new AbortController();
          loop();
        }
      }, intervalMs);
    };
    loop();
  });
};
