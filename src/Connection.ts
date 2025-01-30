import { BaseContext } from './BaseContext.ts';
import { LogSystem } from './Config.ts';
import { ConnectionService } from './ConnectionService.ts';
import { Context } from './Context.ts';
import { BarrierException } from './exceptions.ts';
import { FactSource } from './FactMeta.ts';
import { FactService } from './FactService.ts';
import { Logger } from './Logger.ts';
import { ConnectionProvider } from './NetworkProvider.ts';
import { ConnectionRecordSet } from './record_sets/ConnectionRecordSet.ts';

export class Connection extends BaseContext<Connection> {
  public isConnected=true

  private sendReliableCount=0;
  private sendFastCount=0
  private recvCount=0

  private lastRecvTimestamp:number;

  private log?:Logger

  constructor(public baseCtx:Context,
      private provider: ConnectionProvider,
      private remotePublicKey?: Uint8Array,
      private remoteClientNonce?: string,) {
    super();

    this.lastRecvTimestamp=this.baseCtx.config.timeProvider.now()

    this.log=Logger.create(this.baseCtx,LogSystem.Connection)


  }

  protected override getThis() {
    return this;
  }

  sendReliable(data: Uint8Array)  {
    if (this.isConnected) {
      try {
        this.provider.sendReliable(data);
      } catch (err) {
        this.log?.error(`Caught error sending packet; closing connection: ${err}`, {err})
        this.close()
      }

      this.sendReliableCount++;
      this.baseCtx.maybeGet(ConnectionRecordSet)?.dispatchUpdate(this);
    }
  }

  sendFast(data: Uint8Array)  {
    if (this.isConnected) {
      try {
        this.provider.sendFast(data);
      } catch (err) {
        this.log?.error(`Caught error sending packet; closing connection: ${err}`, {err})
        this.close()
      }

      this.sendFastCount++;
      this.baseCtx.maybeGet(ConnectionRecordSet)?.dispatchUpdate(this);
    }
  }

      close(){
        if (this.isConnected) {
          this.isConnected = false;
          this.provider.shutdown();

          this.baseCtx.get(ConnectionService).removeConnection(this);
          this.baseCtx.maybeGet(ConnectionRecordSet)?.dispatchRemove(this);
  
          // for (const fact of this.knownFacts) {
          //   fact.fromConnections = fact.fromConnections.filter((x) => x !== conn);
          //   fact.toConnections = fact.toConnections.filter((x) => x !== conn);
          // }
        }
      }

 recvData(data:Uint8Array){
  this.recvCount++;
  this.lastRecvTimestamp = this.baseCtx.config.timeProvider.now();

  try {
    const fact = this.baseCtx.get(FactService).ingest(data, FactSource.Remote, this);

  } catch (err) {
    if (err instanceof BarrierException) {
      this.log?.debug(`Caught BarrierException ingesting fact: ${err}`,{err})
    } else {
      this.log?.error(`Error ingesting fact: ${err}`,{err})
      this.close();
    }
  }

  this.baseCtx.maybeGet(ConnectionRecordSet)?.dispatchUpdate(this);

}




  
      const conn: Connection = {
        name: generateSillyName(this.ctx.config.entropyProvider),
        
        recvCount: 0,
        lastRecvTimestamp: this.ctx.config.timeProvider.now(),
        reliability: 0.75,
        isConnected: true,
        knownFacts: remotePublicKey !== undefined && remoteClientNonce !== undefined
          ? mapPut(
            this.knownFactsByClient,
            Hash.digestParts(remotePublicKey, remoteClientNonce).toPrimitive(),
            () => new Set(),
          )
          : new Set(),
        ping: { latest: Infinity, min: Infinity, sum: 0, sqSum: 0, count: 0 },
        altruism: 0,
        earnedBandwidth: 0,
  
        log: Logger.create(this.ctx, LogSystem.Connection),
      };
  
      // conn.peer.connections.add(conn);
      this.connections.push(conn);
      this.ctx.maybeGet(ConnectionRecordSet)?.dispatchAdd(conn);
  
      provider.onClose(shutdown);
      this.ctx.onDestruct(shutdown);
  
      provider.onRecv((data) => {
      });
  
      if (remotePublicKey !== undefined) {
        this.sendIdentification(conn, remotePublicKey);
      }
  
      for (const peer of this.ctx.get(PeerManager).getAll()) {
        for (const [_, infoFact] of peer.clientInfoFacts) {
          this.ctx.get(FactService).sendTo(infoFact, conn);
        }
      }
      this.ctx.get(FactService).emit(
        this.ctx.get(PeerManager).makeInfo(),
        PeerInfo,
        FactType.PeerInfo,
        conn,
      );



}
