import { Context } from './Context.ts';
import { NetworkProvider } from './NetworkProvider.ts';
import { ConnectionService } from './ConnectionService.ts';

export class NetworkService {
  private persistentConnections: { protocol: string; signals: string[] }[] = [];

  constructor(private ctx: Context) {}

  public findProvider(
    providing: string | undefined,
    connectingTo: string | undefined,
  ) {
    const candidates: NetworkProvider[] = [];

    for (const provider of this.ctx.config.networkProviders) {
      const matchesProviding = providing === undefined ||
        provider.providesProtocol === providing;
      const matchesConnectingTo = connectingTo === undefined ||
        (provider.connectsToProtocols ?? [provider.providesProtocol])
          .includes(connectingTo);
      if (matchesProviding && matchesConnectingTo) {
        candidates.push(provider);
      }
    }

    if (candidates.length !== 0) {
      return candidates[
        Math.floor(
          this.ctx.config.entropyProvider.randomNumber() * candidates.length,
        )
      ];
    }
  }

  public getProtocolList() {
    return this.ctx.config.networkProviders.map((x) => x.providesProtocol);
  }

  public initConnection(protocol: string, sendSignal?: (signal: string) => void) {
    const provider = this.findProvider(protocol, undefined);
    if (provider === undefined) {
      throw new Error(`No provider matching ${protocol}`);
    }

    return provider.createInstance({
      ctx: this.ctx,

      protocol,
      useToken: false,

      sendSignal: sendSignal ?? (() => {
        throw new Error(`No signal sender provided for ${protocol}`);
      }),
      createConnection: (provider) =>
        this.ctx.get(ConnectionService).createConnection(protocol, provider),
    });
  }

  public persistConnection(protocol: string, ...signals: string[]) {
    this.persistentConnections.push({ protocol, signals });
    const conn = this.initConnection(protocol);
    signals.forEach((sig, idx) => conn.recvSignal(sig, idx));
  }
}
