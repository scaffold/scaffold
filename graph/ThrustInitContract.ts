import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import GraphUtils from '../sbl/GraphUtils.ts';
import QaDebugger from '../sbl/QaDebugger.ts';
import * as thrustMessages from './thrustMessages.ts';
// import AnswerRegistry from '~/sbl/AnswerRegistry.ts';
// import QaDebugger from '~/sbl/QaDebugger.ts';
// import { SELF_CONNECTION } from '~/sbl/ConnectionService.ts';

export default class ThrustInitContract {
  private contract: Hash;

  constructor(private ctx: Context) {
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

    this.contract = this.ctx.get(GraphUtils).supplyContract(
      thrustGameContract,
    );

    this.ctx.get(QaDebugger).addDebugger(
      'ThrustInitContract',
      this.contract,
      (params) => thrustMessages.InitParams.decode(params),
      (answer) => thrustMessages.InitAnswer.decode(answer),
    );
  }

  public makeParams(match: Hash): Uint8Array {
    return thrustMessages.InitParams.encode({ match });
  }

  public startGame(nonce: Hash): Hash {
    const answer = thrustMessages.InitAnswer.encode({
      nonce,
      init_time: BigInt(Date.now()),
    });
    const match = Hash.digest(answer);
    // const params = thrustMessages.InitParams.encode({ match });

    // this.ctx.get(AnswerRegistry).getOrCreate({
    //   question: { contract_hash: this.get().hash, params },
    //   inputs: [],
    //   answer,
    //   licenses: [],
    //   timestamp: BigInt(Date.now()),
    // }, SELF_CONNECTION);

    return match;
  }

  public get() {
    return this.contract;
  }
}
