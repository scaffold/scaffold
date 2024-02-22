import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { BlockInput, Verifier } from './messages.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { WatchingMonitor } from './util/Monitor.ts';
import { mapPut } from './util/map.ts';
import { Collateralization } from './FactMeta.ts';
import { OutputClaim } from './BlockMeta.ts';

/*
For fetching:
  A:
    Publish incentive B, using an account output on block A.
    Monitor canonicality of incentive B and any outputs.
    When we get an output C, return it.
    Monitor for collateral, also return that
    If B becomes non-canonical, find the closest canonical free account output, and go back to A: to create another incentive.

OutputClaims(block: BlockFact, outputIdx: number)
Canonicality(block: BlockFact)
DerivedWork(block: BlockFact)
Collateral(block: BlockFact)
*/

export class MonitoringService {
  // TODO: How to manage canonicality and validity here?
  public verifierOutputMonitor = new WatchingMonitor<
    Verifier,
    (block: BlockFact, outputIdx: number) => void
  >((verifier) => Hash.digest(Verifier.encode(verifier)).toPrimitive());

  // TODO: How to manage canonicality and validity here?
  // TODO: I don't think this is being used - remove it. It's not tracking canonicality properly
  public verifierInputMonitor = new WatchingMonitor<
    Verifier,
    (block: BlockFact, inputIdx: number) => void
  >((verifier) => Hash.digest(Verifier.encode(verifier)).toPrimitive());

  // TODO: I don't think this is being used - remove it. It's not tracking canonicality properly
  public claimMonitor = new WatchingMonitor<
    BlockInput,
    (claim: OutputClaim) => void
  >((
    input,
  ) => input.blockHash.toPrimitive() + input.outputIdx);

  // public canonicalityMonitor = new WatchingMonitor<Hash, boolean>((hash) =>
  //   hash.toPrimitive()
  // );

  // public derivedWorkMonitor = new WatchingMonitor<Hash, bigint>((hash) =>
  //   hash.toPrimitive()
  // );

  public collateralMonitor = new WatchingMonitor<
    Hash,
    (collateralization: Collateralization) => void
  >((hash) => hash.toPrimitive());

  constructor(private ctx: Context) {}
}

// onIncentiveBlock?: (block: BlockFact) => void;
// onResponseBlock?: (block: BlockFact) => void;
// onResponseCollateral?: (colla) => void;
// The descending frontier chain
// The total derived work / canonicality
