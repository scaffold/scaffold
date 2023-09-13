import { JobMessage } from '~/sbl/worker/workerTypes.ts';
import { ExecutorDriver } from '~/sbl/ExecutorDriverService.ts';
import { INTERRUPT_FLAG } from '~/sbl/worker/WorkerChannel.ts';

// TODO: Hold off on using this.
// We need to figure out how to combine it with local generators, which are keyed off contract hash.
// How should this interact with WASM wrappers?

export default interface ExecutionProvider {
  readonly name: string;
  readonly magicBytes: Uint8Array;

  execute(
    job: JobMessage,
    driver: ExecutorDriver,
    cancel: Promise<typeof INTERRUPT_FLAG>,
  ): Promise<void>;
}
