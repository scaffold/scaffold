// Wires PlacementModule against the production block graph + canonical view.
// Consumers: BlockBuilderModule (solidification) and ConsensusService
// (pre-solidification draft anchor for weight attribution). Both must use
// the same placement instance so their anchor decisions agree.
//
// Cycle break: placement queries the canonical view (via getCanonicalAggregator),
// which depends on consensus-weight, which depends on draft-anchor (via
// NodeWeightsService' draft phantom-block contributions). To prevent the
// placement-of-draft-X path from re-entering placement-of-X, we tell
// NodeWeightsService to skip X while computing the canonical view for X's
// own placement. Placement requests carry their `node` for this reason.

import { Hash } from '../util/Hash.ts';
import { Block, BlockStore } from './Block.ts';
import { ConsensusService } from './ConsensusService.ts';
import { Node } from './Node.ts';
import { PlacementModule, PlacementProvider, PlacementResult } from './PlacementModule.ts';
import { ProtocolContext } from './ProtocolContext.ts';
import { NodeWeightsService } from './NodeWeightsService.ts';

export class PlacementService extends PlacementModule<Block> {
  private readonly nodeWeights: NodeWeightsService;

  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    const consensus = ctx.get(ConsensusService);
    const provider: PlacementProvider<Block> = {
      getBlock: (h: Hash) => store.get(h),
      getAnchor: (b: Block) => b.anchor,
      getAggregates: (b: Block) => b.aggregates,
      getCanonicalAggregator: (h: Hash) => consensus.getCanonicalAggregator(h),
    };
    super(provider);

    this.nodeWeights = ctx.get(NodeWeightsService);
  }

  override place(request: {
    node?: Node;
    claimedBlocks: Hash[];
    aggregatedBlocks: Hash[];
    excludedBlocks: Hash[];
  }): PlacementResult {
    if (!request.node) return super.place(request);
    return this.nodeWeights.withIgnoredNodes(request.node, () => super.place(request));
  }
}
