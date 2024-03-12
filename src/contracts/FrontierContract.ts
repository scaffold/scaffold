import { Context } from '../Context.ts';
import { FrontierTreeParams } from '../messages.ts';
import { ComputationDriver } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { frontierHash } from '../constants.ts';

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

export class FrontierContract implements ContractProvider {
  public contractHash = frontierHash;

  public async compute(driver: ComputationDriver) {
    const { level } = FrontierTreeParams.decode(driver.getParams());
    if (level < 0) {
      throw new Error(`Level cannot be negative!`);
    }

    for (let i = 0; i < frontierInputCount; i++) {
      await driver.requireInput();
    }

    // A little hacky, because if replaced with requireOutput, we wouldn't have the detail yet (because it requires weighing the block).
    driver.requireFrontierLevel(level + 1);
  }
}
