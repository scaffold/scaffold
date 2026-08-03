import { Config } from './Config.ts';
import { Context } from './Context.ts';
import { TransportPlugin } from './interfaces/transport.ts';
import { Fetch, FetchInput } from './peer/Fetch.ts';
import { Transport } from './peer/network/Transport.ts';
import { Send, SendInput } from './peer/Send.ts';

export interface ScaffoldConfig extends Config {
  roles?: { new (ctx: Context): object }[];
}

export class Scaffold {
  private ctx: Context;

  constructor(config: ScaffoldConfig) {
    this.ctx = new Context(config);

    for (const role of config.roles ?? []) this.ctx.get(role);
  }

  async close(): Promise<void> {
    await this.ctx.destruct();
  }

  startTransport(plugin: TransportPlugin, onAnnounce?: (signal: string) => void) {
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

  send(send: SendInput): void {
    return this.ctx.get(Send).send(send);
  }
}
