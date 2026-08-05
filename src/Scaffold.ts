import { Config } from './Config.ts';
import { Context } from './Context.ts';
import { createSource } from './contract/createSource.ts';
import { WasmConfig } from './contract/wasm/WasmConfig.ts';
import { Genesis } from './graph/Genesis.ts';
import { TransportPlugin } from './interfaces/transport.ts';
import { EventLog } from './logic/EventLog.ts';
import { fetchBlob } from './peer/blobFetch.ts';
import { Fetch, FetchInput } from './peer/Fetch.ts';
import { Transport } from './peer/network/Transport.ts';
import { Send, SendInput } from './peer/Send.ts';
import { todo } from './util/functional.ts';
import { Hash } from './util/Hash.ts';

export interface ScaffoldConfig extends Config {
  roles?: { new (ctx: Context): object }[];
}

export class Scaffold {
  private ctx: Context;

  constructor(config: ScaffoldConfig) {
    this.ctx = new Context(config, new EventLog({ console: true }));
    this.ctx.configure(WasmConfig, { fetchBlob });

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

  async serializeParams(contract: Hash | string, params: unknown): Promise<Uint8Array> {
    if (typeof contract === 'string') contract = Hash.fromHex(contract);
    return await this.ctx.get(this.ctx.config.contractPlugin)
      .buildParams(contract, () => createSource(params));
  }

  async serializeData(contract: Hash | string, data: unknown): Promise<Uint8Array> {
    if (typeof contract === 'string') contract = Hash.fromHex(contract);
    return await this.ctx.get(this.ctx.config.contractPlugin)
      .buildData(contract, () => createSource(data));
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
