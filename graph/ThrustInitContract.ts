import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import * as thrustMessages from './thrustMessages.ts';
import GraphUtils from '~/sbl/GraphUtils.ts';
import AnswerRegistry from '~/sbl/AnswerRegistry.ts';
import QaDebugger from '~/sbl/QaDebugger.ts';

export default class ThrustInitContract {
  constructor(private ctx: Context) {}

  public makeParams(match: Hash): Uint8Array {
    return thrustMessages.InitParams.encode({ match });
  }

  public startGame(nonce: Hash): Hash {
    const answer = thrustMessages.InitAnswer.encode({
      nonce,
      init_time: BigInt(Date.now()),
    });
    const match = Hash.digest(answer);
    const params = thrustMessages.InitParams.encode({ match });

    this.ctx.get(AnswerRegistry).getByPub({
      question: { contract_answer_hash: this.get().hash, params },
      inputs: [],
      answer,
      licenses: [],
      timestamp: BigInt(Date.now()),
    });

    return match;
  }

  public get() {
    const thrustGameContract = (
      contractHash: Hash,
      params: Uint8Array,
      _hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      _notify: (contractHash: Hash, params: Uint8Array) => void,
    ) =>
      Hash.equals(
        thrustMessages.InitParams.decode(params).match,
        Hash.digest(request(contractHash, params)),
      );

    // This is a nasty hack until we get WASM working
    (window as any).thrustMessages = thrustMessages;

    const contract = this.ctx.get(GraphUtils).supplyContract(
      thrustGameContract,
    );

    this.ctx.get(QaDebugger).addDebugger(
      'ThrustInitContract',
      contract.hash,
      (params) => thrustMessages.InitParams.decode(params),
      (answer) => thrustMessages.InitAnswer.decode(answer),
    );

    return contract;
  }
}
