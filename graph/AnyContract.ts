import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';

export default class AnyContract {
  constructor(private ctx: Context) {}

  public get() {
    const anyContract = (
      contractHash: Hash,
      params: Uint8Array,
      hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) => true;

    return this.ctx.get(GraphUtils).supplyContract(anyContract);
  }
}
