import { Context } from '../Context.ts';
import { assert } from '../util/functional.ts';
import { AggregatorNodeBase } from '../logic/Forest.ts';
import { Forest } from './Forest.ts';
import { AtomType, Block, BlockRef, ResolvingClaim, ResolvingRef } from './types.ts';

export interface AnchorChainNode {
  payload: { outputs: unknown[] };
  aggregates: { block: Block | BlockRef; outputCount: bigint }[];
}

export class ClaimIndex {
  constructor(private ctx: Context) {}

  propagateClaim(claim: ResolvingClaim | ResolvingRef): void {
    assert(!claim.resolved);
    if (claim.producer.type !== AtomType.Block) return;

    let outputIdx = claim.outputIdx;
    assert(outputIdx >= 0n);

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
    outputBlock: AggregatorNodeBase & AnchorChainNode,
    outputIndex: bigint,
  ): bigint {
    assert(anchorChain.length > 0);

    // const anchorChain = this.ctx.get(Forest).anchorChain(claimingBlock);
    // if (anchorChain === BROKEN_ANCHOR_CHAIN) throw new Error('Broken anchor chain');

    let aggChain: AnchorChainNode[];
    for (aggChain of this.ctx.get(Forest).aggregationChains(outputBlock)) {
      // The last anchor chain node might be a mock.
      // In this case, the aggregation chain won't include it.
      // Here, we add it in synthetically.
      let aggTip = aggChain[aggChain.length - 1];
      if (anchorChain[0].aggregates.some((x) => x.block === aggTip)) {
        aggTip = anchorChain[0];
        aggChain = [...aggChain, aggTip];
      }

      const idx = anchorChain.indexOf(aggTip);
      if (idx !== -1) {
        for (let i = 0; i < idx; ++i) {
          outputIndex += this.countOutputs(anchorChain[i]);
        }

        for (let i = 1; i < aggChain.length; ++i) {
          const child = aggChain[i - 1];
          const parent = aggChain[i];
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
