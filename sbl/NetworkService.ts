import Context from './Context.ts';
import NetworkProvider, { SignalingMode } from '~/sbl/NetworkProvider.ts';
import { mapPut } from '~/sbl/util/map.ts';
import ConnectionService from '~/sbl/ConnectionService.ts';

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

  public getClientProtocols() {
    return this.protocols;
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
