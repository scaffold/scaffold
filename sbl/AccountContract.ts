import { accountHash } from './constants.ts';
import Context from './Context.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import KeyService from './KeyService.ts';
import LocalGeneratorService, {
  INGENERABLE_FLAG,
  LocalGeneratorOpts,
} from './LocalGeneratorService.ts';
import { AccountContractParams } from './messages.ts';
import { arrEquals } from './util/buffer.ts';
import Hash from './util/Hash.ts';
import secp from './util/secp.ts';
import { MaybePromise } from './util/types.ts';
import FactService from '~/sbl/FactService.ts';

export default class AccountContract {
  constructor(private ctx: Context) {
    // ctx.get(LocalGeneratorService).addGenerator(
    //   accountHash,
    //   AccountContract.generate,
    // );
  }

  public verify(
    params: Uint8Array,
    block: BlockFact,
    // request: (
    //   contractHash: Hash,
    //   params: Uint8Array,
    // ) => MaybePromise<Uint8Array>,
    _invert: (hash: Hash) => MaybePromise<Uint8Array>,
  ) {
    const { public_key } = AccountContractParams.decode(params);
    return this.ctx.get(FactService).verify(block, public_key);
  }

  // public static generate(
  //   { ctx, params, emitCorrect, request }: LocalGeneratorOpts,
  // ) {
  //   const { public_key } = AccountContractParams.decode(params);
  //   if (arrEquals(public_key, ctx.get(KeyService).getSelfPublicKey())) {
  //     return new Uint8Array([]);
  //   } else {
  //     return INGENERABLE_FLAG;
  //   }
  // }
}
