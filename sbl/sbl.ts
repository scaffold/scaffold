import Config from './Config.ts';
import Context from './Context.ts';
import FetchService from './FetchService.ts';
import Hash from './util/Hash.ts';

export default class Sbl {
  private ctx: Context;

  constructor(config: Config) {
    // TODO: Build config here, maybe just accept a bootstrap url
    this.ctx = new Context(config);
  }

  public getCtx() {
    return this.ctx;
  }

  public fetch(
    contractHash: Hash,
    params: Uint8Array,
    onData: (data: Uint8Array) => void,
  ) {
    return this.ctx.get(FetchService).fetch(
      { contract_hash: contractHash, params },
      {},
      (block) => onData(block.body),
    );
  }

  public close() {
    return this.ctx.destruct();
  }
}
