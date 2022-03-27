import Peer from './Peer.ts';
import Context from './Context.ts';
import { bin2hex } from './util/hex.ts';
import { getOrCreate } from './util/map.ts';

export default class PeerService {
  private peers: Map<string, Peer> = new Map();

  constructor(private ctx: Context) {}

  public lookup(publicKey: Uint8Array) {
    return getOrCreate(this.peers, bin2hex(publicKey), () => ({
      publicKey,
      meta: {},
      trust: 0,
    }));
  }
}
