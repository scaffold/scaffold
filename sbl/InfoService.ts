import secp from './util/secp.ts';
import Context from './Context.ts';
import NodeService from './NodeService.ts';
import ConnectionService from './ConnectionService.ts';

export default class InfoService {
  constructor(private ctx: Context) {
    this.tick();
  }

  public makeInitPacket() {
    return this.ctx.get(ConnectionService).composePacket(
      this.makeInfoPacket(true),
    );
  }

  private tick() {
    const packet = this.makeInfoPacket(false);
    this.ctx.get(NodeService).getAll().forEach((node) =>
      node.defaultConn?.sendReliable(packet)
    );

    setTimeout(() => this.tick(), 60000 * (Math.random() + 1));
  }

  private makeInfoPacket(includeAuthentication: boolean) {
    const publicKey = secp.getPublicKey(this.ctx.config.selfPrivateKey);
    return {
      InfoMessage: {
        public_key: publicKey,
        node_nonce: this.ctx.config.nodeNonce,
        name: '',
        client_name: '',
        protocol_version: '',
        age_ptr: '',
        neighbors: this.ctx.get(NodeService).getAll().filter(
          (node) => node.defaultConn,
        ).map((node) => ({
          node_hash: node.hash,
          handled_protocols: node.handledProtocols || [],
        })),
      },
    };
  }
}
