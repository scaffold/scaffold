import Context from './Context.ts';
import Hash from './util/Hash.ts';
import AnswerRegistry, { Answer } from './AnswerRegistry.ts';
import { loadHash } from '~/sbl/constants.ts';

export default class GraphUtils {
  constructor(private ctx: Context) {}

  public supplyRawAnswer(answer: Uint8Array) {
    const hash = Hash.digest(answer);

    return this.ctx.get(AnswerRegistry).getByPub({
      question: { contract_answer_hash: loadHash, params: hash.toBytes() },
      inputs: [],
      answer,
      licenses: [],
      timestamp: BigInt(Date.now()),
    });
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
    return this.supplyRawAnswer(new TextEncoder().encode(contract.toString()));
  }

  // TODO: Does this work? Depends on how answer consistency is handled in caller.
  public getGeneratorContract() {
    return this.supplyContract((
      _contractHash: Hash,
      params: Uint8Array, // This is the contract hash we're generating for.
      hint: Uint8Array, // This is the params we're evaluating at.
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) =>
      eval(new TextDecoder().decode(request(loadHash, params)))(
        params,
        hint,
        new Uint8Array([]),
        request,
      )
    );
  }

  public supplyGenerator(
    contract: Answer,
    generator: (
      contractHash: Hash,
      params: Uint8Array,
      emitCorrect: boolean,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      notify: (contractHash: Hash, params: Uint8Array) => void,
    ) => Uint8Array | Promise<Uint8Array>,
  ) {
    return this.ctx.get(AnswerRegistry).getByPub({
      question: {
        contract_answer_hash: this.getGeneratorContract().hash,
        params: contract.hash.toBytes(),
      },
      inputs: [],
      answer: new TextEncoder().encode(generator.toString()),
      licenses: [],
      timestamp: BigInt(Date.now()),
    });
  }
}
