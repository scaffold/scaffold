import secp from './util/secp.ts';
import Context from './Context.ts';
import NodeService from './NodeService.ts';
import KeyService from './KeyService.ts';
import { InfoMessage } from './messages.ts';
import FactService from '~/sbl/FactService.ts';
import { FactType } from '~/sbl/FactMeta.ts';
import Hash, { ZERO_HASH } from '~/sbl/util/Hash.ts';
import NetworkService from '~/sbl/NetworkService.ts';

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
    const info: InfoMessage = {
      network: this.ctx.config.network,
      public_key: publicKey,
      name: '',
      client_name: '',
      protocol_version: '',
      userdata: this.ctx.config.userdata ?? '',
      age_ptr: ZERO_HASH,
      handled_protocols: this.ctx.get(NetworkService).getClientProtocols(),
      neighbors: this.ctx.get(NodeService).getAll()
        .filter((node) => node.defaultConn)
        .map((node) => ({
          node_hash: node.hash,
          handled_protocols: node.handledProtocols || [],
        })),
      bandwidth: Math.floor(40000 / this.ctx.get(NodeService).getAll().length),
    };

    return this.ctx.get(FactService).compose(
      info,
      InfoMessage,
      FactType.Info,
    );
  }
}
