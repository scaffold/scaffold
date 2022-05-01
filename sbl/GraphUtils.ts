import Context from './Context.ts';
import Hash from './util/Hash.ts';
import AnswerRegistry, { Answer } from './AnswerRegistry.ts';
import { loadHash } from './constants.ts';
import { SELF_CONNECTION } from './ConnectionService.ts';
import { Contract, Script } from './scriptTypes.ts';
import { bin2hex, hex2bin } from './util/hex.ts';
import RootContract from '~/graph/RootContract.ts';
import { PublishMessage } from './messages.ts';

// Hacky
(window as any).hex2bin = hex2bin;

export default class GraphUtils {
  constructor(private ctx: Context) {}

  public supplyRawAnswer(answer: Uint8Array) {
    const hash = Hash.digest(answer);

    return this.ctx.get(AnswerRegistry).getOrCreate({
      question: {
        contract_answer_hash: this.ctx.get(RootContract).get().hash,
        params: hash.toBytes(),
      },
      inputs: [],
      answer,
      licenses: [],
      timestamp: BigInt(Date.now()),
    }, SELF_CONNECTION);
  }

  public supplyPubContract(
    contract: (
      publication: PublishMessage,
      hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      notify: (contractHash: Hash, params: Uint8Array) => void,
    ) => boolean | Promise<boolean>,
  ) {
    return this.supplyRawAnswer(new TextEncoder().encode(contract.toString()));
  }

  public supplyContract(
    contract: (
      contractHash: Hash,
      params: Uint8Array,
      hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      notify: (contractHash: Hash, params: Uint8Array) => void,
    ) => boolean | Promise<boolean>,
  ) {
    return this.supplyRawAnswer(
      new TextEncoder().encode(
        `(pub,hint,request,notify)=>(${contract.toString()})(pub.question.contract_answer_hash,pub.question.params,hint,request,notify)`,
      ),
    );
  }

  // TODO: Does this work? Depends on how answer consistency is handled in caller.
  public getGeneratorContract() {
    return this.supplyContract((
      _contractHash: Hash,
      params: Uint8Array, // This is the contract hash we're generating for.
      hint: Uint8Array, // This is the params we're evaluating at.
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) =>
      eval(
        new TextDecoder().decode(
          request(this.ctx.get(RootContract).get().hash, params),
        ),
      )(params, hint, new Uint8Array([]), request)
    );
  }

  public supplyGenerator(
    contract: Answer,
    generator:
      | Script
      | ((
        contractHash: Hash,
        params: Uint8Array,
        emitCorrect: boolean,
        request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
        notify: (contractHash: Hash, params: Uint8Array) => void,
      ) => Uint8Array | Promise<Uint8Array>),
  ) {
    return this.ctx.get(AnswerRegistry).getOrCreate({
      question: {
        contract_answer_hash: this.getGeneratorContract().hash,
        params: contract.hash.toBytes(),
      },
      inputs: [],
      answer: new TextEncoder().encode(
        typeof generator === 'function'
          ? generator.toString()
          : `(${
            JSON.stringify(
              generator,
              (key, val) =>
                val instanceof Uint8Array ? `hex2bin(${bin2hex(val)})` : val,
            ).replace(/"hex2bin\(([0-9a-f]*)\)"/g, 'hex2bin("$1")')
          })`,
      ),
      licenses: [],
      timestamp: BigInt(Date.now()),
    }, SELF_CONNECTION);
  }
}
