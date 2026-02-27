# Trust Module Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the trust module that tracks collateral placements (FOR/AGAINST) on blocks, enforces spending conditions, computes encapsulated weight and claiming limits, and provides trust signals.

**Architecture:** Follows the same provider-based generic pattern as ConsensusModule, ConflictModule, and SamplingModule. A `TrustProvider<BlockType>` interface abstracts block access; `TrustModule<BlockType>` is fully self-contained. Collateral is tracked as placements with paths, sides (FOR/AGAINST), amounts, and spending state.

**Tech Stack:** Deno, TypeScript (strict), `@std/assert` for tests, `Hash`/`HashPrimitive` from existing utils.

---

### Task 1: Write skeleton — interfaces and class stub

**Files:**
- Create: `scaffold/src/TrustModule.ts`

**Step 1: Create TrustModule.ts with all types and empty class**

```typescript
import { Hash, HashPrimitive } from './util/Hash.ts';

/** Which side of a validity dispute this collateral supports. */
export enum CollateralSide {
  For = 'for',
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
  readonly path: number[];
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
  /** Return the declared weight contribution of the child at the given index. */
  getChildDeclaredWeight(block: BlockType, childIndex: number): number;
  /** Return whether H has been superseded (aggregated) by another block. */
  isSuperseded(hash: Hash): boolean;
  /** Return the hashes of blocks that supersede (aggregate) H. */
  getSupersedingBlocks(hash: Hash): Hash[];
  /** Return whether H is in the current canonical view. */
  isCanonical(hash: Hash): boolean;
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

export class TrustModule<BlockType> {
  constructor(provider: TrustProvider<BlockType>) { ... }
  addCollateral(placement: Omit<CollateralPlacement, 'status'>): boolean { ... }
  redeemCollateral(collateralHash: Hash): boolean { ... }
  reclaimCollateral(collateralHash: Hash): boolean { ... }
  claimCollateral(targetHash: Hash, path: number[], winningSide: CollateralSide): number { ... }
  getPlacement(collateralHash: Hash): CollateralPlacement | undefined { ... }
  getPlacementsForTarget(targetHash: Hash): CollateralPlacement[] { ... }
  getPlacementsAtPath(targetHash: Hash, path: number[]): CollateralPlacement[] { ... }
  getTrustState(targetHash: Hash): TrustState { ... }
  getEncapsulatedWeight(targetHash: Hash, path: number[]): number { ... }
  getClaimLimit(targetHash: Hash, path: number[], multiplier: number): number { ... }
  hasActiveTrust(targetHash: Hash): boolean { ... }
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/joel/proj/scaffold && deno check scaffold/src/TrustModule.ts`
Expected: No errors

---

### Task 2: Write tests

**Files:**
- Create: `tests/TrustModule.test.ts`

Tests cover:
1. Adding FOR collateral
2. Adding AGAINST collateral
3. Rejecting collateral when C is a descendant of H
4. Redeeming collateral (happy path — target aggregated)
5. Rejecting redemption when target not yet aggregated
6. Reclaiming collateral when target non-canonical
7. Rejecting reclaim when target is canonical
8. Claiming collateral by winning side
9. Claim limit based on encapsulated weight
10. Encapsulated weight uses aggregator's declared weight when smaller
11. Trust state queries
12. Path-specific placements and queries
13. Double-add prevention
14. Status transitions (can't redeem already-redeemed, etc.)

---

### Task 3: Implement TrustModule

Implement all methods to pass the tests. Iterate until `deno test --allow-all tests/TrustModule.test.ts` passes.
