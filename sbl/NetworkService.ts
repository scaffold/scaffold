import Context from './Context.ts';
import NetworkProvider from '~/sbl/NetworkProvider.ts';
import { getOrCreate } from '~/sbl/util/map.ts';
import ConnectionService from '~/sbl/ConnectionService.ts';

export default class NetworkService {
  private providers = new Map<string, NetworkProvider>();

  constructor(private ctx: Context) {
    for (const provider of ctx.config.networkProviders) {
      getOrCreate(
        this.providers,
        provider.protocolName,
        () => provider,
        () => {
          throw new Error(
            `Multiple network providers exist with protocol name ${provider.protocolName}`,
          );
        },
      );
    }
  }

  public getClientProtocols() {
    return [...this.providers.entries()]
      .filter(([_key, provider]) => provider.createClient)
      .map(([key, _provider]) => key);
  }

  public getProvider(protocol: string) {
    return this.providers.get(protocol);
  }

  public serve(onListen: (protocol: string, spec: string) => void) {
    for (const provider of this.ctx.config.networkProviders) {
      const protocol = provider.protocolName;
      if (provider.createServer) {
        provider.createServer(
          (spec) => onListen(protocol, spec),
          (provider) =>
            this.ctx.get(ConnectionService).initConnection(protocol, provider),
          this.ctx,
        );
      }
    }
  }
}
