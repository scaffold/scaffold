import Context from '~/sbl/Context.ts';
import { FrontierTreeParams } from '../messages.ts';
import { ComputationDriver } from '~/sbl/ComputationMeta.ts';
import { ContractProvider } from '~/sbl/SpecialContractManager.ts';
import { frontierHash } from '~/sbl/constants.ts';
import BlockService from '~/sbl/BlockService.ts';
import Hash from '~/sbl/util/Hash.ts';

// export interface FrontierMeta {
//   // { name: 'left_child', type: 'Hash' },
//   // { name: 'right_child', type: 'Hash' },

//   // { name: 'input_tree_root', type: 'Hash' },
//   // { name: 'output_tree_root', type: 'Hash' },

//   // { name: 'frontier_vote', type: 'Hash' },

//   // { name: 'input_count', type: 'int' },
//   // { name: 'output_count', type: 'int' },

//   // { name: 'level', type: 'int' },
//   // { name: 'score', type: 'int' },
//   // { name: 'claimed_work', type: 'long' },
//   // { name: 'timestamp', type: 'long' },

//   parentBlockSets: BlockSetFact[];
//   myParentBlockSet?: BlockSetFact;
//   active: boolean;

//   knownWork: bigint;

//   includedInputs: Set<HashPrimitive>;
//   includedOutputs: Set<HashPrimitive>;
//   excludedInputs: Set<HashPrimitive>;
//   excludedOutputs: Set<HashPrimitive>;

//   // voters: (BlockFact | BlockSetFact)[];
//   votes: bigint;
// }

export const frontierInputCount = 2;

export default class FrontierContract implements ContractProvider {
  public contractHash = frontierHash;

  public async compute(driver: ComputationDriver, ctx: Context) {
    const { level } = FrontierTreeParams.decode(driver.getParams());
    const sources = await Promise.all(Array.from(
      { length: frontierInputCount },
      (_, i) => driver.getInputSource(i),
    ));
    const effective = sources
      .map((s) => ctx.get(BlockService).get(s.blockHash)!.frontier_vote)
      .filter((v) => !sources.some((t) => Hash.equals(t.blockHash, v)));
    if (effective.length !== 1) {
      throw new Error(`Unmergeable frontier inputs!`);
    }
    driver.requireFrontier(effective[0], level + 1);
  }
}
