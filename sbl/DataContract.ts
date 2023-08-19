import { dataHash } from './constants.ts';
import Context from './Context.ts';
import FactService from '~/sbl/FactService.ts';
import LocalGeneratorService, {
  INGENERABLE_FLAG,
  LocalGeneratorOpts,
} from './LocalGeneratorService.ts';
import { Block, DataContractParams } from './messages.ts';
import NodeService from './NodeService.ts';
import Hash, { HASH_SIZE } from './util/Hash.ts';

// For easy-to-verify contracts in general:
//   Requestor asks for commitments. C(h, s) = c <-> HASH(plaintext) == h && HASH(plaintext | s | provider_public_key_hash) == c
//   The provider gives an initial claim of the validity of his commitment (collateral=1000).
//   Requestor challenges with a claim containing his payment (collateral=1).
//   In order to not lose his collateral, he must provide the plaintext as a hint.
//   It doesn't matter who steals/provides the plaintext, because the requestor claim payment always goes to the provider.

export default class DataContract {
  constructor(private ctx: Context) {
    ctx.get(LocalGeneratorService).addGenerator(
      dataHash,
      DataContract.generate,
    );
  }

  public verify(params: Uint8Array, body: Uint8Array, hint: Uint8Array) {
    const { hash, secret } = DataContractParams.decode(params);
    return body.byteLength === HASH_SIZE &&
      Hash.equals(Hash.digest(hint), hash) &&
      Hash.equals(
        Hash.digestParts(hint, secret, this.ctx.get(NodeService).getSelfHash()),
        Hash.fromBytes(body),
      );
  }

  public static generate({ ctx, params, emitCorrect }: LocalGeneratorOpts) {
    const { hash, secret } = DataContractParams.decode(params);
    const fact = ctx.get(FactService).get(hash);
    if (fact) {
      if (emitCorrect) {
        const commitment = Hash.digestParts(
          fact.data,
          secret,
          ctx.get(NodeService).getSelfHash(),
        );
        return commitment.toBytes();
      } else {
        return Hash.random().toBytes();
      }
    } else {
      return INGENERABLE_FLAG;
    }
  }
}
