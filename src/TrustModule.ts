import { Hash, HashPrimitive } from './util/Hash.ts';

/** Which side of a validity dispute this collateral supports. */
export enum CollateralSide {
  /** Vouches for the validity of a block (or specific path within it). */
  For = 'for',
  /** Alleges invalidity of a specific block within the target's subtree. */
  Against = 'against',
}

/** The current status of a collateral placement. */
export enum CollateralStatus {
  /** Collateral is active and locked. */
  Active = 'active',
  /** Collateral has been redeemed by the publisher (target was aggregated). */
  Redeemed = 'redeemed',
  /** Collateral has been reclaimed (target became non-canonical). */
  Reclaimed = 'reclaimed',
  /** Collateral has been claimed by the winning side of a dispute. */
  Claimed = 'claimed',
}

/** A collateral placement vouching for or against a block's validity. */
export interface CollateralPlacement {
  /** Hash of the collateral block C. */
  readonly collateralHash: Hash;
  /** Hash of the target block H being vouched for/against. */
  readonly targetHash: Hash;
  /** FOR or AGAINST. */
  readonly side: CollateralSide;
  /** Path within H's subtree. [] = entire block, [3,0,1] = specific sub-block. */
  readonly path: readonly number[];
  /** Amount of collateral staked. */
  readonly amount: number;
  /** Current status. */
  readonly status: CollateralStatus;
}

/** Provider interface for the trust module to access block data. */
export interface TrustProvider<BlockType> {
  /** Return the block for a given hash, or undefined if unknown. */
  getBlock(hash: Hash): BlockType | undefined;

  /** Return the anchor hash, or undefined for genesis. */
  getAnchor(block: BlockType): Hash | undefined;

  /** Return the declared weight of the block. */
  getDeclaredWeight(block: BlockType): number;

  /**
   * Return the declared weight contribution of the child at the given index
   * within the block's subtree. This is what the parent aggregator claims
   * the child contributes — may be less than the child's own declared weight.
   */
  getChildDeclaredWeight(block: BlockType, childIndex: number): number;

  /** Return whether H has been superseded (aggregated) by another block. */
  isSuperseded(hash: Hash): boolean;

  /** Return whether H is in the current canonical view. */
  isCanonical(hash: Hash): boolean;

  /**
   * Return whether `ancestor` is an ancestor of `descendant` via anchor chain.
   * Used to enforce the no-circular-trust invariant.
   */
  isAncestor(ancestor: Hash, descendant: Hash): boolean;
}

/** Snapshot of the trust state for a target block. */
export interface TrustState {
  /** Total FOR collateral amount (active only). */
  readonly forAmount: number;
  /** Total AGAINST collateral amount (active only). */
  readonly againstAmount: number;
  /** Number of active placements. */
  readonly activePlacements: number;
}

/** Internal mutable placement record. */
interface PlacementRecord {
  collateralHash: Hash;
  targetHash: Hash;
  side: CollateralSide;
  path: readonly number[];
  amount: number;
  status: CollateralStatus;
}

/**
 * The trust module provides economic incentives for block validity.
 *
 * It tracks collateral placements (FOR/AGAINST) on blocks, enforces spending
 * conditions, computes encapsulated weight and claiming limits, and provides
 * trust signals.
 *
 * Fully self-contained — depends only on TrustProvider and Hash.
 */
export class TrustModule<BlockType> {
  private readonly provider: TrustProvider<BlockType>;

  /** All collateral placements, keyed by collateral block hash. */
  private placements = new Map<HashPrimitive, PlacementRecord>();

  /** Target block hash -> set of collateral hash primitives placed on it. */
  private targetIndex = new Map<HashPrimitive, Set<HashPrimitive>>();

  constructor(provider: TrustProvider<BlockType>) {
    this.provider = provider;
  }

  // -- Mutations --------------------------------------------------

  /**
   * Register a collateral placement. Returns true if accepted.
   *
   * Rejects if:
   * - A placement with this collateral hash already exists
   * - The collateral block C is a descendant of target H (circular trust)
   * - Amount is not positive
   */
  addCollateral(
    collateralHash: Hash,
    targetHash: Hash,
    side: CollateralSide,
    path: readonly number[],
    amount: number,
  ): boolean {
    const key = collateralHash.toPrimitive();

    if (amount <= 0) return false;
    if (this.placements.has(key)) return false;
    if (this.provider.isAncestor(targetHash, collateralHash)) return false;

    const record: PlacementRecord = {
      collateralHash,
      targetHash,
      side,
      path: [...path],
      amount,
      status: CollateralStatus.Active,
    };

    this.placements.set(key, record);
    this.getOrCreateSet(this.targetIndex, targetHash.toPrimitive()).add(key);

    return true;
  }

  /**
   * Redeem collateral (happy path). Publisher reclaims their stake after
   * the target block has been aggregated (superseded).
   *
   * Returns true if redeemed, false if conditions not met.
   */
  redeemCollateral(collateralHash: Hash): boolean {
    const record = this.placements.get(collateralHash.toPrimitive());
    if (!record) return false;
    if (record.status !== CollateralStatus.Active) return false;
    if (!this.provider.isSuperseded(record.targetHash)) return false;

    record.status = CollateralStatus.Redeemed;
    return true;
  }

  /**
   * Reclaim collateral when the target block has become non-canonical.
   * Publisher gets their stake back with no penalty.
   *
   * Returns true if reclaimed, false if conditions not met.
   */
  reclaimCollateral(collateralHash: Hash): boolean {
    const record = this.placements.get(collateralHash.toPrimitive());
    if (!record) return false;
    if (record.status !== CollateralStatus.Active) return false;
    if (this.provider.isCanonical(record.targetHash)) return false;

    record.status = CollateralStatus.Reclaimed;
    return true;
  }

  /**
   * Claim collateral at a specific path after a dispute resolution.
   * The winning side claims the losing side's collateral, up to the claim limit.
   *
   * Returns the total amount claimed.
   */
  claimCollateral(
    targetHash: Hash,
    path: readonly number[],
    winningSide: CollateralSide,
    multiplier: number,
  ): number {
    const losingSide = winningSide === CollateralSide.For
      ? CollateralSide.Against
      : CollateralSide.For;

    const limit = this.getClaimLimit(targetHash, path, multiplier);

    // Find all active losing-side placements at this path
    const losers = this.getActivePlacementsAtPath(targetHash, path)
      .filter((r) => r.side === losingSide);

    let totalClaimed = 0;
    for (const record of losers) {
      const claimable = Math.min(record.amount, limit - totalClaimed);
      if (claimable <= 0) break;
      totalClaimed += claimable;
      record.status = CollateralStatus.Claimed;
    }

    return totalClaimed;
  }

  // -- Queries ----------------------------------------------------

  /** Get a collateral placement by its collateral block hash. */
  getPlacement(collateralHash: Hash): CollateralPlacement | undefined {
    const record = this.placements.get(collateralHash.toPrimitive());
    if (!record) return undefined;
    return { ...record };
  }

  /** Get all collateral placements for a target block. */
  getPlacementsForTarget(targetHash: Hash): CollateralPlacement[] {
    const keys = this.targetIndex.get(targetHash.toPrimitive());
    if (!keys) return [];

    const result: CollateralPlacement[] = [];
    for (const key of keys) {
      const record = this.placements.get(key);
      if (record) result.push({ ...record });
    }
    return result;
  }

  /** Get collateral placements at a specific path within a target block. */
  getPlacementsAtPath(
    targetHash: Hash,
    path: readonly number[],
  ): CollateralPlacement[] {
    return this.getPlacementsForTarget(targetHash)
      .filter((p) => pathEquals(p.path, path));
  }

  /** Get a summary of trust state for a target block. */
  getTrustState(targetHash: Hash): TrustState {
    const placements = this.getPlacementsForTarget(targetHash);
    let forAmount = 0;
    let againstAmount = 0;
    let activePlacements = 0;

    for (const p of placements) {
      if (p.status !== CollateralStatus.Active) continue;
      activePlacements++;
      if (p.side === CollateralSide.For) {
        forAmount += p.amount;
      } else {
        againstAmount += p.amount;
      }
    }

    return { forAmount, againstAmount, activePlacements };
  }

  /**
   * Compute the encapsulated weight for a path within a target block.
   *
   * At root path [], returns the target's own declared weight.
   * At a child path [i, ...], returns the minimum of:
   * - The aggregator's declared contribution for child i
   * - (Recursively, the child's own encapsulated weight at the remaining path)
   *
   * This ensures that if an aggregator lies about a child's contribution
   * being smaller than it actually is, the encapsulated weight reflects
   * what was exposed to the system.
   */
  getEncapsulatedWeight(targetHash: Hash, path: readonly number[]): number {
    const block = this.provider.getBlock(targetHash);
    if (!block) return 0;

    if (path.length === 0) {
      return this.provider.getDeclaredWeight(block);
    }

    // Walk the path: at each step, the encapsulated weight is bounded
    // by what the parent aggregator claimed for this child.
    return this.provider.getChildDeclaredWeight(block, path[0]);
  }

  /**
   * Compute the claiming limit for fraud at a specific path.
   * claim_limit = encapsulated_weight * multiplier
   */
  getClaimLimit(
    targetHash: Hash,
    path: readonly number[],
    multiplier: number,
  ): number {
    return this.getEncapsulatedWeight(targetHash, path) * multiplier;
  }

  /** Whether a target block has any active FOR collateral. */
  hasActiveTrust(targetHash: Hash): boolean {
    const keys = this.targetIndex.get(targetHash.toPrimitive());
    if (!keys) return false;

    for (const key of keys) {
      const record = this.placements.get(key);
      if (
        record &&
        record.status === CollateralStatus.Active &&
        record.side === CollateralSide.For
      ) {
        return true;
      }
    }
    return false;
  }

  // -- Internals --------------------------------------------------

  /** Get active placement records (mutable) at a specific path. */
  private getActivePlacementsAtPath(
    targetHash: Hash,
    path: readonly number[],
  ): PlacementRecord[] {
    const keys = this.targetIndex.get(targetHash.toPrimitive());
    if (!keys) return [];

    const result: PlacementRecord[] = [];
    for (const key of keys) {
      const record = this.placements.get(key);
      if (
        record &&
        record.status === CollateralStatus.Active &&
        pathEquals(record.path, path)
      ) {
        result.push(record);
      }
    }
    return result;
  }

  private getOrCreateSet(
    map: Map<HashPrimitive, Set<HashPrimitive>>,
    key: HashPrimitive,
  ): Set<HashPrimitive> {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    return set;
  }
}

/** Compare two paths for equality. */
function pathEquals(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
