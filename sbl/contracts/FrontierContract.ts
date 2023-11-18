import { FrontierTreeParams } from '../messages.ts';
import { ComputationDriver } from '~/sbl/WorkerLauncherService.ts';
import { ContractProvider } from '~/sbl/SpecialContractManager.ts';
import { frontierHash } from '~/sbl/constants.ts';

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

export default class FrontierContract implements ContractProvider {
  public contractHash = frontierHash;

  public async compute(driver: ComputationDriver) {
    await driver.getInputSource(0);
    await driver.getInputSource(1);
    const { level } = FrontierTreeParams.decode(driver.getParams());
    driver.requireFrontierLevel(level + 1);
  }
}
