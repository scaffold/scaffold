import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';

export default class RootContract {
  constructor(private ctx: Context) {}

  public get() {
    const rootContract = (
      contractHash: Hash,
      params: Uint8Array,
      hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) =>
      Hash.equals(
        Hash.digest(request(contractHash, params)),
        Hash.fromBytes(params),
      );

    return this.ctx.get(GraphUtils).supplyContract(rootContract);
  }
}
