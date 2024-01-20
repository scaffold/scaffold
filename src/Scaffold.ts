import Config from './Config.ts';
import Context from './Context.ts';
import FetchService from './FetchService.ts';
import Query from './Query.ts';
import { Resource } from './Query.ts';
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

  public fetch(resource: Resource, onAnswer: (answer: Uint8Array) => void) {
    todo();
    return this.ctx.get(FetchService).fetch(
      Query.fromResource(resource).toVerifier(),
      {},
      (block) => onAnswer(block.body),
    );
  }

  public put(resource: Resource, answer: Uint8Array) {
    todo();
  }

  public close() {
    return this.ctx.destruct();
  }
}
