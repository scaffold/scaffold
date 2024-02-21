import { Hash, ZERO_HASH } from './util/Hash.ts';
import { BlockFact } from './FactMeta.ts';
import { WeightService } from './WeightService.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { Context } from './Context.ts';
import { frontierInputCount } from './contracts/FrontierContract.ts';
import { GenesisService } from './GenesisService.ts';
import { FrontierHelper } from './FrontierHelper.ts';
import { BlockService } from './BlockService.ts';
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

const isFrontier = (input: { block: BlockFact; outputIdx?: number }) =>
  input.outputIdx === input.block.frontierOutputIdx;

export class FrontierChainService {
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
      inputs.flatMap((input) => isFrontier(input) ? [input.block] : []),
    );

    if (frontierInputs.size > frontierInputCount) {
      return undefined;
    }

    const requireVoteLevel = Math.max(
      ...[...frontierInputs].map((fi) => fi.frontierParams.level),
    ) + 1;
    const voteLevel = Math.max(targVoteLevel, requireVoteLevel + 1);

    // Inputs that are not a tree child of a frontier input
    const externalInputs = new Set<BlockFact>([
      this.ctx.get(GenesisService).getGenesisBlock(),
    ]);

    for (const { block } of inputs) {
      if (!doesIntersect(frontierInputs, this.getAllParents(block))) {
        externalInputs.add(block);
      }
    }

    for (const fi of frontierInputs) {
      if (fi.frontierVoteBlock === undefined) {
        // throw new Error(`Unconnected frontier chain!`);
        return undefined;
      } else if (!frontierInputs.has(fi.frontierVoteBlock)) {
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
      this.getAllParents(input)
    );

    let res = [...externalInputs].find((input) => {
      const chain = this.getFrontierChain(input);
      return requireInclusion.every((p) => doesIntersect(chain, p));
    });

    if (res === undefined) {
      // TODO: Descend towards voters?
      return undefined;
    }

    if (res.frontierParams.level < voteLevel) {
      // Go to parent
      do {
        const next = this.ctx.get(WeightService).getDescendant(res);
        if (!next.isParent) {
          break;
        }
        res = next.immediate ?? error(`No immediate descendant!`);
      } while (res.frontierParams.level < voteLevel);
    } else if (res.frontierParams.level > voteLevel) {
      // Go to best voter
      // do {
      //   const next = this.ctx.get(WeightService).getCanonicalVoter(res);
      //   if (next === undefined) {
      //     break;
      //   }
      //   res = next;
      // } while (res.frontierParams.level > voteLevel);
    }

    if (res.frontierParams.level < requireVoteLevel) {
      return undefined;
    }

    try {
      FrontierHelper.mergeTreeIo(
        inputs,
        res,
        (hash) =>
          this.ctx.get(BlockService).get(hash, false) ??
            error(`Unknown frontier child input!`),
      );
    } catch (_err) {
      return undefined;
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

  public getFrontierChain(block: BlockFact) {
    return this.recurse(block, (el, queue) => {
      switch (el.frontierVoteBlock) {
        case undefined:
          // throw new Error(`Unconnected frontier chain!`);
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
