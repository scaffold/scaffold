import { JobMessage } from '~/sbl/worker/workerTypes.ts';
import { MaybePromise } from '~/sbl/util/types.ts';
import { ComputationDriver } from './ComputationMeta.ts';

// TODO: Hold off on using this.
// We need to figure out how to combine it with local generators, which are keyed off contract hash.
// How should this interact with WASM wrappers?

export default interface ExecutionProvider {
  readonly name: string;
  readonly magicBytes: Uint8Array;

  execute(job: JobMessage, driver: ComputationDriver): MaybePromise<void>;
}
