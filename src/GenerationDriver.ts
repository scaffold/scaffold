import { ComputationDriver } from './ComputationMeta.ts';

export class GenerationDriver implements ComputationDriver{

  constructor(    verifier: Verifier,
    workerDriver: WorkerDriver,){}

  finalize(err: unknown): MaybePromise<void>{

  }
}

