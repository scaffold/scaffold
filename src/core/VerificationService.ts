import { Hash } from '../util/Hash.ts';
import { ExecutionResult } from './ExecutionModule.ts';
import { ExecutionService } from './ExecutionService.ts';
import { ProbeResult } from './ProbeModule.ts';
import { ProbeService } from './ProbeService.ts';
import { VerificationModule, VerificationProvider } from './VerificationModule.ts';
import { ProtocolContext } from './ProtocolContext.ts';

class VerificationProviderAdapter implements VerificationProvider {
  constructor(
    private readonly probe: ProbeService,
    private readonly execution: ExecutionService,
  ) {}

  selectNextTree(): Hash | undefined {
    return this.probe.selectNext();
  }

  initProbe(treeHash: Hash): ProbeResult {
    return this.probe.initProbe(treeHash);
  }

  verifyBlock(blockHash: Hash): ExecutionResult {
    return this.execution.verifyBlock(blockHash);
  }

  recordVerification(blockHash: Hash, success: boolean): void {
    this.probe.recordVerification(blockHash, success);
  }
}

/** VerificationModule wired to ProbeService and ExecutionService via ProtocolContext. */
export class VerificationService extends VerificationModule {
  constructor(ctx: ProtocolContext) {
    const probe = ctx.get(ProbeService);
    const execution = ctx.get(ExecutionService);
    super(new VerificationProviderAdapter(probe, execution));
  }
}
