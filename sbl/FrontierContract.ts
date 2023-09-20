import { frontierHash } from './constants.ts';
import Context from './Context.ts';
import LocalGeneratorService, {
  ANY_BODY_FLAG,
  LocalGeneratorOpts,
} from './LocalGeneratorService.ts';
import { FrontierTreeDetail, FrontierTreeParams } from './messages.ts';
import { ZERO_HASH } from '~/sbl/util/Hash.ts';

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
    { ctx, params, details, emitCorrect, addOutput }: LocalGeneratorOpts,
  ): typeof ANY_BODY_FLAG {
    const { level } = FrontierTreeParams.decode(params);
    addOutput({
      verifier: {
        contract_hash: frontierHash,
        params: FrontierTreeParams.encode({ level: level + 1 }),
      },
      amount: 10n,
      detail: FrontierTreeDetail.encode({
        input_tree_root: ZERO_HASH,
        output_tree_root: ZERO_HASH,

        input_count: 0,
        output_count: 0,

        block_count: 1,
        claimed_work: 100n,
        // { name: 'input_tree_root', type: 'Hash' },
        // { name: 'output_tree_root', type: 'Hash' },

        // { name: 'input_count', type: 'int' }, // TODO: long
        // { name: 'output_count', type: 'int' }, // TODO: long

        // { name: 'block_count', type: 'int' }, // TODO: long
        // { name: 'claimed_work', type: 'long' },
      }),
    });
    return ANY_BODY_FLAG;
  }
}
