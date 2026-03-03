import { Strategy, ReactiveEvent, Action, VerifierKey, FetchResult } from '../ReactiveLayer.ts';
import { FetchManager } from '../FetchManager.ts';

/**
 * FetchNotifyStrategy reacts to canonicality changes and notifies the
 * FetchManager when blocks matching active fetch subscriptions become
 * canonical or lose canonicality.
 *
 * For each canonicality change:
 *   1. Look up the block in the store.
 *   2. For each output, compute the verifier key from the output's
 *      contract hash and data (used as params).
 *   3. If the FetchManager has an active subscription for that key:
 *      - If the block became canonical, emit a notifyFetch action with the output data.
 *      - If the block lost canonicality, emit a notifyFetch action with null.
 */
export class FetchNotifyStrategy implements Strategy {
  constructor(private readonly fetchManager: FetchManager) {}

  evaluate(event: ReactiveEvent): Action[] {
    const { canonicalityChanges } = event.result;
    if (canonicalityChanges.length === 0) {
      return [];
    }

    const actions: Action[] = [];

    for (const change of canonicalityChanges) {
      const block = event.store.get(change.hash);
      if (!block) continue;

      for (const output of block.outputs) {
        const key: VerifierKey = FetchManager.verifierKey({
          contractHash: output.contract,
          params: output.data,
        });

        if (!this.fetchManager.hasSubscription(key)) continue;

        if (change.canonical) {
          const result: FetchResult = { data: output.data };
          actions.push({ type: 'notifyFetch', verifier: key, result });
        } else {
          actions.push({ type: 'notifyFetch', verifier: key, result: null });
        }
      }
    }

    return actions;
  }
}
