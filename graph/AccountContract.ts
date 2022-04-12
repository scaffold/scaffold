import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import * as accountMessages from './accountMessages.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';

export default class AccountContract {
  constructor(private ctx: Context) {}

  public makeParams(idx: bigint): Uint8Array {
    return accountMessages.Params.encode({ idx });
  }

  public get() {
    const accountGenerator = (
      _contractHash: Hash,
      _params: Uint8Array,
      emitCorrect: boolean,
      _request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) => {
      if (!emitCorrect) {
        return new TextEncoder().encode('DUPE');
      }

      return accountMessages.Answer.encode({});
    };

    const accountContract = (
      contractHash: Hash,
      params: Uint8Array,
      _hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) =>
      // Just run the generator and check it equals the candidate answer.
      arrEquals(
        accountGenerator(contractHash, params, true, request),
        request(contractHash, params),
      );

    // This is a nasty hack until we get WASM working
    (window as any).accountGenerator = accountGenerator;
    (window as any).accountMessages = accountMessages;

    const contract = this.ctx.get(GraphUtils).supplyContract(accountContract);
    this.ctx.get(GraphUtils).supplyGenerator(contract, accountGenerator);

    return contract;
  }
}
