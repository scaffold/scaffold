import { Config } from './Config.ts';
import { Context } from './Context.ts';
import { createSource } from './contract/createSource.ts';
import { Source, SourceRoot } from './contract/values.ts';
import { WasmConfig } from './contract/wasm/WasmConfig.ts';
import { Genesis } from './graph/Genesis.ts';
import { TransportPlugin } from './interfaces/transport.ts';
import { fetchBlob } from './peer/blobFetch.ts';
import { Fetch, FetchInput } from './peer/Fetch.ts';
import { Transport } from './peer/network/Transport.ts';
import { Put, PutInput } from './peer/Put.ts';
import { Send, SendInput } from './peer/Send.ts';
import { once, todo } from './util/functional.ts';
import { Hash } from './util/Hash.ts';
import { MaybePromise } from './util/MaybePromise.ts';

export interface ScaffoldConfig extends Config {
  roles?: { new (ctx: Context): object }[];
}

export class Scaffold {
  private ctx: Context;

  constructor(config: ScaffoldConfig) {
    this.ctx = new Context(config);
    this.ctx.configure(WasmConfig, { fetchBlob });

    // Make sure the genesis block is loaded
    this.ctx.get(Genesis);

    for (const role of config.roles ?? []) this.ctx.get(role);
  }

  @once
  async close(): Promise<void> {
    this.ctx.logger('scaffold')?.info('closing');
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

  serializeParamsSource(contract: Hash | string, params: SourceRoot): MaybePromise<Uint8Array> {
    if (typeof contract === 'string') contract = Hash.fromHex(contract);
    return this.ctx.get(this.ctx.config.contractPlugin).buildParams(contract, params);
  }

  serializeBodySource(contract: Hash | string, body: SourceRoot): MaybePromise<Uint8Array> {
    if (typeof contract === 'string') contract = Hash.fromHex(contract);
    return this.ctx.get(this.ctx.config.contractPlugin).buildBody(contract, body);
  }

  serializeParamsObj(contract: Hash | string, params: unknown): MaybePromise<Uint8Array> {
    return this.serializeParamsSource(contract, () => createSource(params));
  }

  serializeBodyObj(contract: Hash | string, body: unknown): MaybePromise<Uint8Array> {
    return this.serializeBodySource(contract, () => createSource(body));
  }

  fetch(input: FetchInput): Promise<void> {
    return this.ctx.get(Fetch).fetch(input);
  }

  put(input: PutInput): Promise<void> {
    return this.ctx.get(Put).put(input);
  }

  send(send: SendInput): void {
    return this.ctx.get(Send).send(send);
  }
}
