import { Hash } from '../util/Hash.ts';
import { ExecutionResult } from './ExecutionModule.ts';
import { ExecutionService } from './ExecutionService.ts';
import { SampleResult } from './SamplingModule.ts';
import { SamplingService } from './SamplingService.ts';
import { VerificationModule, VerificationProvider } from './VerificationModule.ts';
import { ProtocolContext } from './ProtocolContext.ts';

class VerificationProviderAdapter implements VerificationProvider {
  constructor(
    private readonly sampling: SamplingService,
    private readonly execution: ExecutionService,
  ) {}

  selectNextTree(): Hash | undefined {
    return this.sampling.selectNext();
  }

  initSample(treeHash: Hash): SampleResult {
    return this.sampling.initSample(treeHash);
  }

  verifyBlock(blockHash: Hash): ExecutionResult {
    return this.execution.verifyBlock(blockHash);
  }

  recordVerification(blockHash: Hash, success: boolean): void {
    this.sampling.recordVerification(blockHash, success);
  }
}

/** VerificationModule wired to SamplingService and ExecutionService via ProtocolContext. */
export class VerificationService extends VerificationModule {
  constructor(ctx: ProtocolContext) {
    const sampling = ctx.get(SamplingService);
    const execution = ctx.get(ExecutionService);
    super(new VerificationProviderAdapter(sampling, execution));
  }
}
