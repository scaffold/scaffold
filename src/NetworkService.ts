import Context from './Context.ts';
import NetworkProvider from './NetworkProvider.ts';
import { mapPut } from './util/map.ts';
import ConnectionService from './ConnectionService.ts';

const protocolRegex = /^(.+?)(?:\/(\w+))?$/;

interface ParsedProtocol {
  name: string;
  subtype?: string;
}

export default class NetworkService {
  private providers = new Map<
    string,
    { provider: NetworkProvider; subtype?: string }[]
  >();
  private protocols: string[];

  constructor(private ctx: Context) {
    const protoSet = new Set<string>();
    for (const provider of ctx.config.networkProviders) {
      const protocols = provider.protocols === undefined
        ? []
        : Array.isArray(provider.protocols)
        ? provider.protocols
        : [provider.protocols];
      for (const protocol of protocols) {
        const { name, subtype } = this.parseProtocol(protocol);

        if (
          subtype !== undefined && subtype !== 'client' && subtype !== 'server'
        ) {
          throw new Error(`Unhandled subtype ${subtype}!`);
        }

        mapPut(this.providers, name, () => []).push({ provider, subtype });

        protoSet.add(protocol);
      }
    }
    this.protocols = Array.from(protoSet);
  }

  public parseProtocol(protocol: string): ParsedProtocol {
    const match = protocolRegex.exec(protocol);
    if (match === null) {
      throw new Error(`Invalid protocol ${protocol}!`);
    }
    return { name: match[1], subtype: match[2] };
  }

  public findProviderMatching({ name, subtype }: ParsedProtocol) {
    return this.providers.get(name)
      ?.find((x) => this.areSubtypesCompatible(subtype, x.subtype))
      ?.provider;
  }

  public getProtocolList() {
    return this.protocols;
  }

  public initConnection(
    protocol: string | ParsedProtocol,
    requirePublicKey?: Uint8Array,
    sendSignal?: (signal: string) => void,
  ) {
    const parsed = typeof protocol === 'string'
      ? this.parseProtocol(protocol)
      : protocol;
    const provider = this.findProviderMatching(parsed);
    if (provider === undefined) {
      throw new Error(`No provider matching ${parsed.name}/${parsed.subtype}`);
    }

    return provider.createInstance({
      ctx: this.ctx,

      protocolName: parsed.name,
      isInitiator: true,

      sendSignal: sendSignal ?? (() => {
        throw new Error(
          `No signal sender provided for ${parsed.name}/${parsed.subtype}`,
        );
      }),
      createConnection: (provider) =>
        this.ctx.get(ConnectionService)
          .createConnection(parsed.name, provider, requirePublicKey),
    });
  }

  private areSubtypesCompatible(a?: string, b?: string) {
    if (a === undefined || b === undefined) {
      return true;
    } else if (a === 'server' && b === 'client') {
      return true;
    } else if (a === 'client' && b === 'server') {
      return true;
    } else {
      return false;
    }
  }

  // public serve(onListen: (protocol: string, spec: string) => void) {
  //   for (const provider of this.ctx.config.networkProviders) {
  //     const protocol = provider.protocolName;
  //     if (provider.createServer) {
  //       provider.createServer(
  //         (spec) => onListen(protocol, spec),
  //         (provider) =>
  //           this.ctx.get(ConnectionService).initConnection(protocol, provider),
  //         this.ctx,
  //       );
  //     }
  //   }
  // }
}
