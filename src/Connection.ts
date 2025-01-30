import { BaseContext } from './BaseContext.ts';
import { LogSystem } from './Config.ts';
import { ConnectionService } from './ConnectionService.ts';
import { Context } from './Context.ts';
import { BarrierException } from './exceptions.ts';
import { Fact, FactSource } from './FactMeta.ts';
import { FactService } from './FactService.ts';
import { Logger } from './Logger.ts';
import { ConnectionProvider } from './NetworkProvider.ts';
import { ConnectionRecordSet } from './record_sets/ConnectionRecordSet.ts';
import { generateSillyName } from './util/sillyNameGenerator.ts';

export class Connection extends BaseContext<Connection> {
  // TODO: Remove
  public sillyName: string;

  public isConnected = true;

  private sendReliableCount = 0;
  private sendFastCount = 0;
  private recvCount = 0;

  private lastRecvTimestamp: number;

  // TODO: Remove
  public reliability = 1;
  public earnedBandwidth = 0;
  public knownFacts = new Set<Fact>();

  private log?: Logger;

  constructor(
    public baseCtx: Context,
    private provider: ConnectionProvider,
    public remotePublicKey?: Uint8Array,
    public remoteClientNonce?: string,
  ) {
    super();

    this.sillyName = generateSillyName(this.baseCtx.config.entropyProvider),
      this.lastRecvTimestamp = this.baseCtx.config.timeProvider.now();

    this.log = Logger.create(this.baseCtx, LogSystem.Connection);

    this.baseCtx.maybeGet(ConnectionRecordSet)?.dispatchAdd(this);
  }

  protected override getThis() {
    return this;
  }

  sendReliable(data: Uint8Array) {
    if (this.isConnected) {
      try {
        this.provider.sendReliable(data);
      } catch (err) {
        this.log?.error(`Caught error sending packet; closing connection: ${err}`, { err });
        this.close();
      }

      this.sendReliableCount++;
      this.baseCtx.maybeGet(ConnectionRecordSet)?.dispatchUpdate(this);
    }
  }

  sendFast(data: Uint8Array) {
    if (this.isConnected) {
      try {
        this.provider.sendFast(data);
      } catch (err) {
        this.log?.error(`Caught error sending packet; closing connection: ${err}`, { err });
        this.close();
      }

      this.sendFastCount++;
      this.baseCtx.maybeGet(ConnectionRecordSet)?.dispatchUpdate(this);
    }
  }

  close() {
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

  recvData(data: Uint8Array) {
    this.recvCount++;
    this.lastRecvTimestamp = this.baseCtx.config.timeProvider.now();

    try {
      this.baseCtx.get(FactService).ingest(data, FactSource.Remote, this);
    } catch (err) {
      if (err instanceof BarrierException) {
        this.log?.debug(`Caught BarrierException ingesting fact: ${err}`, { err });
      } else {
        this.log?.error(`Error ingesting fact: ${err}`, { err });
        this.close();
      }
    }

    this.baseCtx.maybeGet(ConnectionRecordSet)?.dispatchUpdate(this);
  }
}
