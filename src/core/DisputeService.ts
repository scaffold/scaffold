import { Hash } from '../util/Hash.ts';
import { CollateralPlacement, CollateralSide, CollateralStatus } from './TrustModule.ts';
import { TrustService } from './TrustService.ts';
import { DisputeModule, DisputeProvider } from './DisputeModule.ts';
import { ProtocolContext } from './ProtocolContext.ts';

class DisputeProviderAdapter implements DisputeProvider {
  constructor(private readonly trust: TrustService) {}

  getCollateralPlacements(targetHash: Hash): CollateralPlacement[] {
    return this.trust.getPlacementsForTarget(targetHash);
  }

  getValidStake(targetHash: Hash): number {
    const state = this.trust.getTrustState(targetHash);
    return state.forAmount;
  }

  getInvalidStake(targetHash: Hash): number {
    const state = this.trust.getTrustState(targetHash);
    return state.againstAmount;
  }
}

/** DisputeModule wired to TrustService via ProtocolContext. */
export class DisputeService extends DisputeModule {
  constructor(ctx: ProtocolContext) {
    const trust = ctx.get(TrustService);
    super(new DisputeProviderAdapter(trust));
  }
}
