// Service adapter for TrustGate. Wires the module to
// BlockVerificationService and CollateralResolutionIndexService via
// ProtocolContext.

import type { Hash } from '../util/Hash.ts';
import { BlockVerificationService } from '../core/BlockVerificationService.ts';
import { ProtocolContext } from '../core/ProtocolContext.ts';
import { CollateralResolutionIndexService } from './CollateralResolutionIndexService.ts';
import {
  TrustGate,
  type TrustGateProvider,
  type VerdictQuery,
  type VerificationStatus,
} from './TrustGate.ts';

export class TrustGateService extends TrustGate {
  constructor(ctx: ProtocolContext) {
    const blockVerification = ctx.get(BlockVerificationService);
    const index = ctx.get(CollateralResolutionIndexService);

    const provider: TrustGateProvider = {
      getVerificationStatus(h: Hash): VerificationStatus {
        return blockVerification.getStatus(h);
      },
      onVerificationStatusChanged(cb) {
        return blockVerification.onStatusChanged(cb);
      },
      requestVerification(h: Hash) {
        return blockVerification.verify(h);
      },
      getVerdict(h: Hash): VerdictQuery {
        return index.verdict(h);
      },
      onVerdictChanged(cb) {
        return index.onVerdictChanged(cb);
      },
    };

    super(provider);
  }
}
