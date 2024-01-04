import secp from './util/secp.ts';
import Context from './Context.ts';
import NodeService from './NodeService.ts';
import KeyService from './KeyService.ts';
import { NodeInfo } from './messages.ts';
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

  private tick() {
    // const packet = this.makeInfoPacket(false);
    // this.ctx.get(NodeService).getAll().forEach((node) =>
    //   node.defaultConn?.sendReliable(packet)
    // );

    // this.tickItvl = setTimeout(() => this.tick(), 60000 * (Math.random() + 1));
  }

  public makeInfoPacket() {
    const neighbors = this.ctx.get(NodeService).getNeighbors();

    const info: NodeInfo = {
      timestamp: this.ctx.config.timeProvider.now(),
      network: this.ctx.config.network,
      name: '',
      client_name: '',
      protocol_version: '',
      userdata: this.ctx.config.userdata ?? '',
      age_ptr: ZERO_HASH,
      protocols: this.ctx.get(NetworkService).getProtocolList(),
      neighbors,
      bandwidth: Math.floor(40000 / neighbors.length),
    };

    return this.ctx.get(FactService).compose(info, NodeInfo, FactType.NodeInfo);
  }
}
