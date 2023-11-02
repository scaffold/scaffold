import { frontierHash } from './constants.ts';
import Context from './Context.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import LocalGeneratorService from './LocalGeneratorService.ts';
import { FrontierTreeDetail, FrontierTreeParams } from './messages.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import { MaybePromise } from '~/sbl/util/types.ts';
import { ComputationDriver } from '~/sbl/WorkerLauncherService.ts';

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

export default class FrontierContract {
  constructor(private ctx: Context) {}

  public async compute(driver: ComputationDriver) {
    await driver.getInputDetail(0);
    await driver.getInputDetail(1);
    const { level } = FrontierTreeParams.decode(driver.getParams());
    // driver.setFrontierLevel(level + 1);
  }
}
