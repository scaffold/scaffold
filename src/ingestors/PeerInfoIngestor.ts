import { ClockService } from '../ClockService.ts';
import { Context } from '../Context.ts';
import { CryptoHelper } from '../CryptoHelper.ts';
import { FactEmitter } from '../FactEmitter.ts';
import { FactBase } from '../FactMeta.ts';
import { FactSource, FactType, PeerInfoFact } from '../FactMeta.ts';
import { FactService } from '../FactService.ts';
import { IngestionProvider } from '../IngestionProvider.ts';
import { PeerManager } from '../PeerManager.ts';
import { SignalingService } from '../SignalingService.ts';
import { PeerInfo, SignalPayload } from '../messages.ts';

export class PeerInfoIngestor implements IngestionProvider<FactType.PeerInfo> {
  type = FactType.PeerInfo as const;
  isTransient = false as const;
  isPersistent = true;
  isSigned = true;

  constructor(private ctx: Context) {}

  create(base: FactBase) {
    return Object.assign(
      base,
      PeerInfo.decode(base.message),
      { type: FactType.PeerInfo as const },
    );
  }

  ingest(fact: PeerInfoFact) {
    if (fact.network !== this.ctx.config.network) {
      throw new Error(
        `Mismatched networks! ${fact.network} !== ${this.ctx.config.network}`,
      );
    }

    if (fact.userdata) {
      // TODO: Store on the fact
      JSON.parse(fact.userdata);
    }

    if (!this.isInfoValid(fact)) {
      throw new Error(`Invalid info fact!`);
    }

    const publicKey = this.ctx.get(FactService).getPublicKey(fact);
    const peer = this.ctx.get(PeerManager).putPeer(publicKey);

    const isNewClient = !peer.clientInfoFacts.has(fact.clientNonce);
    peer.clientInfoFacts.set(fact.clientNonce, fact);

    // for (const request of peer.infoRequests) {
    //   this.ctx.get(FactService).sendTo(fact, request.fromConnections);
    // }
    // peer.infoRequests.clear();

    // peer.neighbors.clear();
    // peer.hops = Infinity;
    // for (const neighbor of fact.neighbors) {
    //   const neighborNode = this.getOrCreate(neighbor);

    //   neighborNode.neighbors.add(peer);
    //   peer.neighbors.add(neighborNode);

    //   peer.hops = Math.min(peer.hops, neighborNode.hops + 1);

    //   if (neighborNode.isRemote) {
    //     this.connectTo(neighborNode);
    //   }
    // }

    // for (const neighborNode of peer.neighbors) {
    //   neighborNode.hops = Math.min(neighborNode.hops, peer.hops + 1);
    // }

    if (isNewClient) {
      this.ctx.get(PeerManager).connectTo(fact);
    }

    this.ctx.get(FactService).publish(fact);
  }

  forget(fact: PeerInfoFact) {}

  private isInfoValid(info: PeerInfoFact) {
    return true;
    // const now = BigInt(this.ctx.config.timeProvider.now());
    // return info.timestamp >= now - BigInt(infoExpirationMs) &&
    //   info.timestamp <= now;
  }
}
