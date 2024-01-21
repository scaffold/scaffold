import secp from './util/secp.ts';
import Context from './Context.ts';
import NodeService from './NodeService.ts';
import KeyService from './KeyService.ts';
import { NodeInfo } from './messages.ts';
import FactService from './FactService.ts';
import { FactType } from './FactMeta.ts';
import Hash, { ZERO_HASH } from './util/Hash.ts';
import NetworkService from './NetworkService.ts';

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

  public makeInfo(): NodeInfo {
    const neighbors = this.ctx.get(NodeService).getNeighbors();

    return {
      timestamp: BigInt(this.ctx.config.timeProvider.now()),
      network: this.ctx.config.network,
      name: '',
      clientName: '',
      protocolVersion: '',
      userdata: this.ctx.config.userdata ?? '',
      agePtr: ZERO_HASH,
      protocols: this.ctx.get(NetworkService).getProtocolList(),
      neighbors,
      bandwidth: Math.floor(40000 / (neighbors.length + 1)),
    };
  }
}
