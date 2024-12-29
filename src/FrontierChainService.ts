import { Hash, HashPrimitive, ZERO_HASH } from './util/Hash.ts';
import { BlockFact } from './FactMeta.ts';
import { WeightService } from './WeightService.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { Context } from './Context.ts';
import { frontierInputCount } from './contracts/FrontierContract.ts';
import { GenesisService } from './GenesisService.ts';
import { FrontierHelper } from './FrontierHelper.ts';
import { BlockService } from './BlockService.ts';
import { error, todo } from './util/functional.ts';
import { FactService } from './FactService.ts';
import { setsIntersect } from './util/set.ts';

const targVoteLevel = 4;

const isFrontier = (input: { block: BlockFact; outputIdx?: number }) =>
  input.outputIdx === input.block.frontierOutputIdx;

export class FrontierChainService {
  constructor(private ctx: Context) {}

  public getVote(inputs: { block: BlockFact; outputIdx?: number }[]) {
    const uniqueInputs = new Set<HashPrimitive>();
    for (const input of inputs) {
      const key = input.block.hash.toPrimitive() + input.outputIdx;
      if (uniqueInputs.has(key)) {
        return undefined;
      }
      uniqueInputs.add(key);
    }

    if (!this.ctx.config.enableFrontierVote) {
      return ZERO_BLOCK;
    }

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
      if (!setsIntersect(frontierInputs, this.getAllParents(block))) {
        externalInputs.add(block);
      }
    }

    for (const fi of frontierInputs) {
      if (fi.frontierVoteBlock === undefined) {
        // throw new Error(`Unconnected frontier chain!`);
        return undefined;
      } else if (fi.frontierVoteBlock === ZERO_BLOCK) {
        todo();
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

    // const cache = this.ctx.get(WeightService).makeCache();
    let res = this.ctx.get(FactService).hackyGetBlocksMatching()
      .filter((input) => {
        const chain = this.getFrontierChain(input);
        return requireInclusion.every((p) => setsIntersect(chain, p));
      })
      .sort((a, b) =>
        Number(
          this.ctx.get(WeightService).getCanonicality(b).canonicality -
            this.ctx.get(WeightService).getCanonicality(a).canonicality,
        )
      )[0];

    if (res === undefined) {
      // TODO: Descend towards voters?
      return undefined;
    }

    while (true) {
      const next = this.ctx.get(WeightService).getDescendant(res);
      if (next.parent === undefined) {
        break;
      }
      res = next.parent;
    }

    // if (res.frontierParams.level > voteLevel) {
    //   // Go to best voter
    //   do {
    //     const next = this.ctx.get(WeightService).getDescendant(res);
    //     if (next.voters.length === 0) {
    //       break;
    //     }
    //     res = next.voters[0];
    //   } while (res.frontierParams.level > voteLevel);
    // }

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

  public isAncestor(ancestor: BlockFact, descendant: BlockFact) {
    return setsIntersect(
      this.getAllParents(ancestor),
      this.getFrontierChain(descendant),
    );
  }

  public getFrontierChain(block: BlockFact) {
    return this.recurse(block, (el, queue) => {
      switch (el.frontierVoteBlock) {
        case undefined:
          // throw new Error(`Unconnected frontier chain!`);
          break;
        case ZERO_BLOCK:
          break;
        default:
          queue.push(el.frontierVoteBlock);
      }
    });
  }

  public getAllParents(
    block: BlockFact | typeof ZERO_BLOCK,
  ): Set<BlockFact | typeof ZERO_BLOCK> {
    if (block === ZERO_BLOCK) {
      return new Set([ZERO_BLOCK]);
    }
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
