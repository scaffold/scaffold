import Context from './Context.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import Hash, { HASH_SIZE } from './util/Hash.ts';
import { MaybePromise } from './util/types.ts';
import LocalGeneratorService, {
  INGENERABLE_FLAG,
  LocalGeneratorOpts,
} from '~/sbl/LocalGeneratorService.ts';
import { rootHash } from '~/sbl/constants.ts';
import FactService from '~/sbl/FactService.ts';

export default class RootContract {
  constructor(private ctx: Context) {
    ctx.get(LocalGeneratorService).addGenerator(
      rootHash,
      RootContract.generate,
    );
  }

  public verify(
    params: Uint8Array,
    block: BlockFact,
    _invert: (hash: Hash) => MaybePromise<Uint8Array>,
  ) {
    return params.byteLength === HASH_SIZE &&
      Hash.equals(Hash.digest(block.body), Hash.fromBytes(params));
  }

  public static generate({ ctx, params }: LocalGeneratorOpts) {
    const hash = Hash.fromBytes(params);
    const fact = ctx.get(FactService).get(hash);
    if (fact) {
      return fact.data;
    } else {
      return INGENERABLE_FLAG;
    }
  }
}
