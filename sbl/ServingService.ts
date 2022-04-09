import Context from './Context.ts';
import { ConnectionProvider } from './NetworkProvider.ts';
import ConnectionService from './ConnectionService.ts';

export default class ServingService {
  constructor(private ctx: Context) {}

  public serve(onListen: (protocol: string, spec: string) => void) {
    this.ctx.config.networkProvider.protocols.forEach(
      (provider, protocol) => {
        if (provider.serve) {
          const onNewConn = (provider: ConnectionProvider) =>
            this.ctx.get(ConnectionService).initConnection(protocol, provider);
          provider.serve((spec) => onListen(protocol, spec), onNewConn);
        }
      },
    );
  }
}
