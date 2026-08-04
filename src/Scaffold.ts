import { Config } from './Config.ts';
import { Context } from './Context.ts';
import { Genesis } from './graph/Genesis.ts';
import { TransportPlugin } from './interfaces/transport.ts';
import { Fetch, FetchInput } from './peer/Fetch.ts';
import { Transport } from './peer/network/Transport.ts';
import { Send, SendInput } from './peer/Send.ts';
import { todo } from './util/functional.ts';

export interface ScaffoldConfig extends Config {
  roles?: { new (ctx: Context): object }[];
}

export class Scaffold {
  private ctx: Context;

  constructor(config: ScaffoldConfig) {
    this.ctx = new Context(config);

    // Make sure the genesis block is loaded
    this.ctx.get(Genesis);

    for (const role of config.roles ?? []) this.ctx.get(role);
  }

  async close(): Promise<void> {
    await this.ctx.destruct();
  }

  getContext(): Context {
    return this.ctx;
  }

  startTransport(plugin: TransportPlugin, onAnnounce?: (url: URL) => void) {
    this.ctx.get(Transport).startTransport(plugin, onAnnounce);
  }

  stopTransport(plugin: TransportPlugin) {
    this.ctx.get(Transport).stopTransport(plugin);
  }

  connect(url: string | URL) {
    this.ctx.get(Transport).connect(url instanceof URL ? url : new URL(url));
  }

  fetch(input: FetchInput): Promise<void> {
    return this.ctx.get(Fetch).fetch(input);
  }

  put(): never {
    return todo();
  }

  send(send: SendInput): void {
    return this.ctx.get(Send).send(send);
  }
}
