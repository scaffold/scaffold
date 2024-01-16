import Config from './Config.ts';
import Context from './Context.ts';
import FetchService from './FetchService.ts';
import Hash from './util/Hash.ts';
import { todo } from './util/functional.ts';

export default class Scaffold {
  private ctx: Context;

  constructor(config: Config) {
    this.ctx = new Context(config);
  }

  public getCtx() {
    return this.ctx;
  }

  public fetch(
    contractHash: Hash | string,
    params: Uint8Array,
    onAnswer: (answer: Uint8Array) => void,
  ) {
    return this.ctx.get(FetchService).fetch(
      {
        contract_hash: contractHash instanceof Hash
          ? contractHash
          : Hash.fromHex(contractHash),
        params,
      },
      {},
      (block) => onAnswer(block.body),
    );
  }

  public put(
    contractHash: Hash | string,
    params: Uint8Array,
    answer: Uint8Array,
  ) {
    todo();
  }

  public close() {
    return this.ctx.destruct();
  }
}
