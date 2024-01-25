import Hash, { ZERO_HASH } from './util/Hash.ts';
import { BlockFact } from './FactMeta.ts';
import WeightService from './WeightService.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import Context from './Context.ts';
import { frontierHash } from './constants.ts';
import { todo } from './util/functional.ts';
import BlockService from './BlockService.ts';
import FrontierService2 from './FrontierService2.ts';
import { error } from './util/functional.ts';

const targVoteLevel = 4;

// TODO: Move to set util
const doesIntersect = <T>(a: Set<T>, b: Set<T>) => {
  if (a.size > b.size) {
    const t = a;
    a = b;
    b = t;
  }
  for (const x of a) {
    if (b.has(x)) {
      return true;
    }
  }
  return false;
};

export default class FrontierChainService {
  constructor(private ctx: Context) {}

  public getVote(inputs: { block: BlockFact; outputIdx?: number }[]) {
    // try {
    //   const hash = this.ctx.get(FrontierService2).getBlockVote(inputs);
    //   return this.ctx.get(BlockService).get(hash, false)!;
    // } catch (err) {
    //   console.error(err);
    //   return ZERO_BLOCK;
    // }

    /*
    The parent set of a non-frontier is all parents, recursively
    The parent set of a frontier is

    1. Get the chain root that includes all other inputs
    2.
    */

    const frontierInputs = new Set(
      inputs.flatMap((input) =>
        input.outputIdx !== undefined && Hash.equals(
            input.block.outputs[input.outputIdx].verifier.contractHash,
            frontierHash,
          )
          ? [input.block]
          : []
      ),
    );

    const externalInputs = new Set<BlockFact | typeof ZERO_BLOCK>([ZERO_BLOCK]);

    for (const { block } of inputs) {
      if (!doesIntersect(frontierInputs, this.getAllParents(block))) {
        externalInputs.add(block);
      }
    }
    for (const fi of frontierInputs) {
      if (fi.frontierVoteBlock === undefined) {
        throw new Error(`Unconnected frontier chain!`);
      } else if (
        fi.frontierVoteBlock !== ZERO_BLOCK &&
        !frontierInputs.has(fi.frontierVoteBlock)
      ) {
        externalInputs.add(fi.frontierVoteBlock);
      }
    }

    // {
    //   let ptr = input.block;
    //   while (true) {
    //     const intersector = findIntersector(
    //       frontierInputs,
    //       this.getAllParents(ptr),
    //     );
    //     if (intersector !== undefined) {}
    //     const next = ptr.frontierVoteBlock ??
    //       error(`Unconnected frontier chain!`);
    //     if (next === ZERO_BLOCK) {
    //       return ZERO_BLOCK;
    //     }
    //     ptr = next;
    //   }
    //   return ptr;
    // });

    const requireInclusion = [...externalInputs].map((input) =>
      input === ZERO_BLOCK
        ? new Set<BlockFact | typeof ZERO_BLOCK>([ZERO_BLOCK])
        : this.getAllParents(input)
    );

    let res = [...externalInputs].find((input) => {
      const chain = input === ZERO_BLOCK
        ? new Set()
        : this.getFrontierChain(input);
      chain.add(ZERO_BLOCK);
      return requireInclusion.every((p) => doesIntersect(chain, p));
    });

    if (res === ZERO_BLOCK) {
      // do {
      //   const next = this.ctx.get(WeightService).getCanonicalVoter(res);
      //   if (next === undefined) {
      //     break;
      //   }
      //   res = next;
      // } while (res.frontierParams.level > targVoteLevel);
      return res;
    }

    if (res !== undefined) {
      if (res.frontierParams.level < targVoteLevel) {
        // Go to parent
        do {
          const next = this.ctx.get(WeightService).getCanonicalParent(res);
          if (next === undefined) {
            break;
          }
          res = next;
        } while (res.frontierParams.level < targVoteLevel);
      } else if (res.frontierParams.level > targVoteLevel) {
        // Go to best voter
        // do {
        //   const next = this.ctx.get(WeightService).getCanonicalVoter(res);
        //   if (next === undefined) {
        //     break;
        //   }
        //   res = next;
        // } while (res.frontierParams.level > targVoteLevel);
      }
    }

    return res;
  }

  // // Returns the shortest chain
  // public intersect(...chains: BlockFact[]) {
  //   this.sortAndVerifyMergeable(chains);
  //   return chains[0];
  // }

  // // Returns the longest chain
  // public union(...chains: BlockFact[]) {
  //   this.sortAndVerifyMergeable(chains);
  //   return chains[chains.length - 1];
  // }

  // private sortAndVerifyMergeable(chains: BlockFact[]) {
  //   chains.sort((a, b) => a.frontierChainDepth! - b.frontierChainDepth!);
  //   for (let i = 1; i < chains.length; i++) {
  //     if (!this.extends(chains[i - 1], chains[i])) {
  //       throw new Error(`Chains are not mergeable!`);
  //     }
  //   }
  // }

  // private extends(shorter: BlockFact, longer: BlockFact) {
  //   if (
  //     longer.frontierChainDepth === undefined ||
  //     shorter.frontierChainDepth === undefined
  //   ) {
  //     throw new Error(`Incomplete frontier chain!`);
  //   }

  //   while (longer.frontierChainDepth! > shorter.frontierChainDepth!) {
  //     const next = longer.frontierVoteBlock;
  //     if (next === undefined || next === ZERO_BLOCK) {
  //       throw new Error(`Internal error!`);
  //     }
  //     longer = next;
  //   }

  //   return longer === shorter;
  // }

  // private getBestParent(block: BlockFact) {
  //   let bestScore: bigint | undefined;
  //   let bestParent: BlockFact | undefined;
  //   for (const claim of block.outputClaims[block.frontierOutputIdx]) {
  //     const score = this.ctx.get(WeightService).getCanonicality(claim.block);
  //     if (bestParent === undefined || score > bestScore!) {
  //       bestScore = score;
  //       bestParent = claim.block;
  //     }
  //   }
  //   return bestParent;
  // }

  private getFrontierChain(block: BlockFact) {
    return this.recurse(block, (el, queue) => {
      switch (el.frontierVoteBlock) {
        case undefined:
          throw new Error(`Unconnected frontier chain!`);
        case ZERO_BLOCK:
          break;
        default:
          queue.push(el.frontierVoteBlock);
      }
    });
  }

  private getAllParents(block: BlockFact) {
    return this.recurse(block, (el, queue) => {
      for (const claim of el.outputClaims[el.frontierOutputIdx]) {
        queue.push(claim.block);
      }
    });
  }

  private recurse(
    block: BlockFact,
    pusher: (el: BlockFact, queue: BlockFact[]) => void,
  ) {
    const queue = [block];
    for (let i = 0; i < queue.length; i++) {
      pusher(queue[i], queue);
    }
    return new Set(queue);
  }
}
