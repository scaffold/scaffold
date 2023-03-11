import { BlockExt } from './BlockMeta.ts';
import Context from './Context.ts';
import Hash, { HASH_SIZE } from './util/Hash.ts';
import { MaybePromise } from './util/types.ts';

export default class RootContract {
  constructor(private ctx: Context) {}

  public verify(
    params: Uint8Array,
    block: BlockExt,
    _invert: (hash: Hash) => MaybePromise<Uint8Array>,
  ) {
    return params.byteLength === HASH_SIZE &&
      Hash.equals(Hash.digest(block.body), Hash.fromBytes(params));
  }
}
