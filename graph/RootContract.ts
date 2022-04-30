import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';
import AnswerRegistry from '~/sbl/AnswerRegistry.ts';
import { rootHash } from '~/sbl/constants.ts';
import { SELF_CONNECTION } from '~/sbl/ConnectionService.ts';

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

    return this.ctx.get(AnswerRegistry).getOrCreate({
      question: { contract_answer_hash: rootHash, params: new Uint8Array([]) },
      inputs: [],
      answer: new TextEncoder().encode(rootContract.toString()),
      licenses: [],
      timestamp: BigInt(Date.now()),
    }, SELF_CONNECTION);
  }
}
