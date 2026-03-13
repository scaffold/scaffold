import { Hash } from '../util/Hash.ts';
import { ExecutionResult } from './ExecutionModule.ts';
import { ExecutionService } from './ExecutionService.ts';
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

  verifyBlock(blockHash: Hash): ExecutionResult {
    return this.execution.verifyBlock(blockHash);
  }

  reportSuccess(treeHash: Hash): void {
    this.sampling.recordSampleSuccess(treeHash);
  }

  reportFailure(treeHash: Hash): void {
    this.sampling.recordSampleFailure(treeHash);
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
