import { BlockFact } from '~/sbl/FactMeta.ts';
import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import BlockService from '~/sbl/BlockService.ts';
import { frontierHash } from '~/sbl/constants.ts';
import { FrontierTreeParams } from '~/sbl/messages.ts';

/*
Propagate derived work towards frontier_vote and frontier inputs. Choose and propagate canonicality forwards.
When we get a block or increment the work, propagate it towards frontier_vote.
To get the derived work, fetch the descendant work property of our block, and that of all recursive parent (frontier output claim) blocks.
When we have multiple claimants of an output, simply choose the highest-scoring by D-S and set all other works to zero or the minimum.
*/

export default class FrontierService2 {
  constructor(private ctx: Context) {}

  public getBlockVote(inputs: { block: BlockFact; outputIdx: number }[]) {
    // this.ctx.get(BlockService).getBlocksByVerifier({
    //   contract_hash: frontierHash,
    //   params: FrontierTreeParams.encode({ level: 0 }),
    // });

    // if (this.frontierSets.length !== 0) {
    //   const idx = Math.floor(
    //     this.ctx.config.entropyProvider.randomNumber() *
    //       this.frontierSets.length,
    //   );
    //   return this.frontierSets[idx];
    // }
  }
}
