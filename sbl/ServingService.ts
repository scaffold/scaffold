import Context from './Context.ts';
import { ConnectionProvider } from './NetworkProvider.ts';
import ConnectionService from './ConnectionService.ts';

export default class ServingService {
  constructor(private ctx: Context) {
    ctx.config.networkProvider.protocols.forEach(
      (provider, protocol) => {
        if (provider.serve) {
          const onListen = (spec: string) => {
            console.log(
              `ProtocolProvider ${protocol} is listening with spec ${
                JSON.stringify(spec)
              }`,
            );
          };
          const onNewConn = (provider: ConnectionProvider) =>
            ctx.get(ConnectionService).initConnection(protocol, provider);
          provider.serve(onListen, onNewConn);
        }
      },
    );
  }
}
