import { Context } from '../Context.ts';
import { assert } from '../util/functional.ts';
import { ForestService } from './ForestService.ts';
import { AtomType, Block, BLOCK_REF_TYPE, ResolvingClaim, ResolvingRef } from './types.ts';

interface ResolveOutputBlock {
  type: AtomType.Block | typeof BLOCK_REF_TYPE;

  anchor: this;
  aggregates: { block: ThisType<ResolveOutputBlock>; outputCount: bigint }[];

  // These are other nodes referring to this atom by hash
  // anchoringNodes: Block[];
  // aggregatingNodes: Block[];
  // resolvingOutputs: Map<bigint, ResolvingClaim[]>;
}

export interface AnchorChainNode {
  payload: { outputs: unknown[] };
  aggregates: { outputCount: bigint }[];
}

export class ClaimIndexService {
  constructor(private ctx: Context) {}

  propagateClaim(claim: ResolvingClaim | ResolvingRef): void {
    assert(!claim.resolved);
    if (claim.producer.type !== AtomType.Block) return;

    let outputIdx = claim.outputIdx;
    const outputCount = BigInt(claim.producer.payload.outputs.length);
    if (outputIdx < outputCount) {
      claim.resolved = true;
      return;
    }
    outputIdx -= outputCount;

    for (let i = claim.producer.aggregates.length; i-- > 0;) {
      const { block, outputCount } = claim.producer.aggregates[i];
      if (outputIdx < outputCount) {
        claim.producer = block;
        claim.outputIdx = outputIdx;
        this.propagateClaim(claim);
        return;
      }
      outputIdx -= outputCount;
    }

    if (claim.producer.anchor === undefined) throw new Error('Claim index out of bounds');

    claim.producer = claim.producer.anchor;
    claim.outputIdx = outputIdx;
    this.propagateClaim(claim);
  }

  resolveClaimIndex(
    anchorChain: AnchorChainNode[],
    outputBlock: Block,
    outputIndex: bigint,
  ): bigint {
    // const anchorChain = this.ctx.get(ForestService).anchorChain(claimingBlock);
    // if (anchorChain === BROKEN_ANCHOR_CHAIN) throw new Error('Broken anchor chain');

    for (const chain of this.ctx.get(ForestService).aggregationChains(outputBlock)) {
      const idx = (anchorChain as object[]).indexOf(chain[chain.length - 1]);
      if (idx !== -1) {
        for (let i = 0; i < idx; ++i) {
          outputIndex += this.countOutputs(anchorChain[i]);
        }

        for (let i = 1; i < chain.length; ++i) {
          const child = chain[i - 1];
          const parent = chain[i];
          const aggIdx = parent.aggregates.findIndex((agg) => agg.block === child);
          outputIndex += this.countOutputs(parent, aggIdx);
        }

        return outputIndex;
      }
    }

    throw new Error('No route found');
  }

  // Counts the outputs after an aggregate.
  // -1 = all aggregates (use this to count the total outputs introduced by a subtree)
  countOutputs(
    block: { payload: { outputs: unknown[] }; aggregates: { outputCount: bigint }[] },
    aggregateIndex = -1,
  ): bigint {
    let outputCount = BigInt(block.payload.outputs.length);
    for (let i = aggregateIndex; ++i < block.aggregates.length;) {
      outputCount += block.aggregates[i].outputCount;
    }
    return outputCount;
  }
}
