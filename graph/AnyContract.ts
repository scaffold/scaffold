import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';
import QaDebugger from '~/sbl/QaDebugger.ts';

export default class AnyContract {
  constructor(private ctx: Context) {}

  public get() {
    const anyContract = (
      contractHash: Hash,
      params: Uint8Array,
      hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) => true;

    const contract = this.ctx.get(GraphUtils).supplyContract(anyContract);

    this.ctx.get(QaDebugger).addDebugger(
      'AnyContract',
      contract.hash,
      (params) => ({ params }),
      (answer) => ({}),
    );

    return contract;
  }
}
