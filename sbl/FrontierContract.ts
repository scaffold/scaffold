import { frontierHash } from './constants.ts';
import Context from './Context.ts';
import LocalGeneratorService, {
  ANY_BODY_FLAG,
  INGENERABLE_FLAG,
  LocalGeneratorOpts,
} from './LocalGeneratorService.ts';
import { FrontierTreeDetail, FrontierTreeParams } from './messages.ts';
import { HashPrimitive } from '~/sbl/util/Hash.ts';

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
  constructor(private ctx: Context) {
    ctx.get(LocalGeneratorService).addGenerator(
      frontierHash,
      FrontierContract.generate,
    );
  }

  public verify(params: Uint8Array, body: Uint8Array, hint: Uint8Array) {
    const { level } = FrontierTreeParams.decode(params);
    // TODO: Verify
    return true;
  }

  public static generate(
    { ctx, params, details, setFrontierLevel }: LocalGeneratorOpts,
  ): typeof ANY_BODY_FLAG | typeof INGENERABLE_FLAG {
    if (details.length < 2) {
      return INGENERABLE_FLAG;
    }
    const { level } = FrontierTreeParams.decode(params);
    setFrontierLevel(level + 1);
    return ANY_BODY_FLAG;
  }
}
