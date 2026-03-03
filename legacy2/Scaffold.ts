import { Config } from './Config.ts';
import { Context } from './Context.ts';
import { FetchOptions, FetchService } from './FetchService.ts';
import { Query } from './Query.ts';
import { Resource } from './Query.ts';
import { Verifier } from './messages.ts';
import { DataTree } from './protocol/base.ts';
import { todo } from './util/functional.ts';

export type FetchCallback = (body?: DataTree) => void;

export class Scaffold {
  private ctx: Context;

  constructor(config: Config) {
    this.ctx = new Context(config);
  }

  public getCtx() {
    return this.ctx;
  }

  public fetch(
    verifier: Verifier,
    optionsOrCallback: FetchOptions | FetchCallback,
    callback?: FetchCallback,
  ) {
    if (typeof optionsOrCallback === 'function') {
      optionsOrCallback = { onBody: optionsOrCallback };
    }

    if (callback !== undefined) {
      if (optionsOrCallback.onBody !== undefined) {
        throw new Error(`Cannot pass two callbacks!`);
      }
      optionsOrCallback.onBody = callback;
    }

    return this.ctx.get(FetchService).fetch(verifier, optionsOrCallback);
  }

  public put(resource: Resource, body: Uint8Array) {
    todo();
  }

  public close() {
    return this.ctx.destruct();
  }
}
