import secp from './util/secp.ts';
import Context from './Context.ts';
import NodeService from './NodeService.ts';
import KeyService from './KeyService.ts';
import { InfoMessage } from './messages.ts';
import IngestionService from '~/sbl/IngestionService.ts';
import { FactType } from '~/sbl/FactMeta.ts';

export default class InfoService {
  private tickItvl?: number;

  constructor(private ctx: Context) {
    this.tick();
    ctx.onDestruct(() => clearTimeout(this.tickItvl));
  }

  public makeInitPacket() {
    return this.makeInfoPacket(true);
  }

  private tick() {
    // const packet = this.makeInfoPacket(false);
    // this.ctx.get(NodeService).getAll().forEach((node) =>
    //   node.defaultConn?.sendReliable(packet)
    // );

    // this.tickItvl = setTimeout(() => this.tick(), 60000 * (Math.random() + 1));
  }

  private makeInfoPacket(includeAuthentication: boolean) {
    const publicKey = this.ctx.get(KeyService).getSelfPublicKey();
    const info = {
      public_key: publicKey,
      node_nonce: this.ctx.config.nodeNonce,
      name: '',
      client_name: '',
      protocol_version: '',
      userdata: this.ctx.config.userdata ?? '',
      age_ptr: '',
      handled_protocols: [...this.ctx.config.networkProvider.protocols]
        .filter(([_key, provider]) => provider.createClient)
        .map(([key, _provider]) => key),
      neighbors: this.ctx.get(NodeService).getAll()
        .filter((node) => node.defaultConn)
        .map((node) => ({
          node_hash: node.hash,
          handled_protocols: node.handledProtocols || [],
        })),
    };

    return this.ctx.get(IngestionService).compose(
      info,
      InfoMessage,
      FactType.Info,
    );
  }
}
