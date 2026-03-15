// Protocol spec: docs/protocol/computation.md (collateral and dispute resolution)

import { Hash } from '../util/Hash.ts';
import { Output } from './BlockCreationModule.ts';
import { SIGNATURE_CONTRACT } from './Block.ts';
import { CollateralPlacement, CollateralSide, CollateralStatus } from './TrustModule.ts';

// -- Types ----------------------------------------------------------

/** The vote in a dispute: valid or invalid. */
export enum DisputeVote {
  Valid = 'valid',
  Invalid = 'invalid',
}

/** Result of resolving a dispute. */
export interface ResolutionResult {
  /** The target block being disputed. */
  readonly targetHash: Hash;
  /** The winning side. */
  readonly winningSide: DisputeVote;
  /** Total stake on the VALID side. */
  readonly validStake: number;
  /** Total stake on the INVALID side. */
  readonly invalidStake: number;
  /** Outputs directing funds to the winners (proportional shares). */
  readonly requiredOutputs: Output[];
}

// -- Provider -------------------------------------------------------

/** Provider interface for the dispute module to access collateral data. */
export interface DisputeProvider {
  /** Get all active collateral placements for a target block. */
  getCollateralPlacements(targetHash: Hash): CollateralPlacement[];

  /** Get total active FOR (Valid) stake for a target. */
  getValidStake(targetHash: Hash): number;

  /** Get total active AGAINST (Invalid) stake for a target. */
  getInvalidStake(targetHash: Hash): number;
}

// -- DisputeModule ---------------------------------------------------

/**
 * The dispute module resolves collateral disputes using majority-by-stake.
 *
 * After a resolution event, it:
 * 1. Sums VALID and INVALID stakes.
 * 2. Determines the winning side (majority by stake; VALID wins ties).
 * 3. Computes proportional payouts from total collateral to winners.
 * 4. Returns a ResolutionResult with required outputs for a resolution block.
 */
export class DisputeModule {
  private readonly _provider: DisputeProvider;

  constructor(provider: DisputeProvider) {
    this._provider = provider;
  }

  /**
   * Resolve a dispute for a target block.
   * Returns the resolution result with winning side and payout outputs.
   */
  resolve(targetHash: Hash): ResolutionResult {
    const validStake = this._provider.getValidStake(targetHash);
    const invalidStake = this._provider.getInvalidStake(targetHash);
    const placements = this._provider.getCollateralPlacements(targetHash);

    // Majority by stake wins. VALID wins ties.
    const winningSide = invalidStake > validStake ? DisputeVote.Invalid : DisputeVote.Valid;

    // The winning collateral side (FOR = Valid, AGAINST = Invalid)
    const winningSidePlacement = winningSide === DisputeVote.Valid
      ? CollateralSide.For
      : CollateralSide.Against;

    // Total collateral pool (all active placements)
    const totalPool = validStake + invalidStake;

    // Compute proportional payouts to winners
    const winners = placements.filter(
      (p) => p.status === CollateralStatus.Active && p.side === winningSidePlacement,
    );

    const winnersTotalStake = winners.reduce((sum, w) => sum + w.amount, 0);

    const requiredOutputs: Output[] = [];
    if (totalPool > 0 && winnersTotalStake > 0) {
      for (const winner of winners) {
        const share = (winner.amount / winnersTotalStake) * totalPool;
        if (share <= 0) continue;

        // Payout output: signature contract locked to the winner's collateral hash
        // (simplified: in production, the collateral output's detail would contain
        //  a remittance pubkey)
        requiredOutputs.push({
          verifier: {
            contract: SIGNATURE_CONTRACT,
            params: winner.collateralHash.toBytes(),
          },
          value: share,
          detail: new Uint8Array(0),
        });
      }
    }

    return {
      targetHash,
      winningSide,
      validStake,
      invalidStake,
      requiredOutputs,
    };
  }

  /**
   * Build a BlockSpec-compatible resolution structure for a target.
   * Convenience method wrapping resolve().
   */
  buildResolutionSpec(targetHash: Hash, anchorHash: Hash): {
    anchor: Hash;
    outputs: Output[];
    claims: number[];
    declaredWeight: number;
    aggregates: Hash[];
    refs: Hash[];
  } {
    const result = this.resolve(targetHash);

    return {
      anchor: anchorHash,
      outputs: result.requiredOutputs,
      claims: [],
      declaredWeight: 1,
      aggregates: [],
      refs: [targetHash],
    };
  }
}
