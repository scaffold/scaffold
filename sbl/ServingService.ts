import Context from './Context.ts';
import { ConnectionProvider } from './NetworkProvider.ts';
import ConnectionService from './ConnectionService.ts';

export default class ServingService {
  constructor(private ctx: Context) {}

  public serve(onListen: (protocol: string, spec: string) => void) {
    this.ctx.config.networkProvider.protocols.forEach(
      (provider, protocol) => {
        if (provider.createServer) {
          provider.createServer(
            (spec) => onListen(protocol, spec),
            (provider) =>
              this.ctx.get(ConnectionService).initConnection(
                protocol,
                provider,
              ),
            this.ctx,
          );
        }
      },
    );
  }
}
