import { BaseContext } from './BaseContext.ts';
import { LogSystem } from './Config.ts';
import { ConnectionService } from './ConnectionService.ts';
import { Context } from './Context.ts';
import { BarrierException } from './exceptions.ts';
import { Fact, FactSource } from './FactMeta.ts';
import { FactService } from './FactService.ts';
import { Logger } from './Logger.ts';
import { ConnectionDriver, ConnectionProvider } from './NetworkProvider.ts';
import { ConnectionRecordSet } from './record_sets/ConnectionRecordSet.ts';
import { generateSillyName } from './util/sillyNameGenerator.ts';
import { MessageJoiner, MessageSplitter } from '../src/util/MessageSplitter.ts';
import { HashPrimitive } from './util/Hash.ts';

export class Connection extends BaseContext<Connection> implements ConnectionDriver {
  // TODO: Remove
  public sillyName: string;

  public isConnected = true;

  private sendReliableCount = 0;
  private sendFastCount = 0;
  private recvCount = 0;

  private lastRecvTimestamp: number;

  private msgSplitter: MessageSplitter;
  private msgJoiner: MessageJoiner;

  // Facts we've sent to them
  public knownFacts = new Set<Fact>();

  // Hashes they've sent to us
  public knownHashes = new Set<HashPrimitive>();

  // TODO: Remove
  public reliability = 1;
  public earnedBandwidth = Infinity;

  private log?: Logger;

  constructor(
    public ctx: Context,
    private provider: ConnectionProvider,
    public remotePublicKey?: Uint8Array,
    public remoteClientNonce?: string,
  ) {
    super();

    this.sillyName = generateSillyName(this.ctx.config.entropyProvider);
    this.lastRecvTimestamp = this.ctx.config.timeProvider.now();

    // We create a MessageSplitter even when we don't need to, so the remote can assume it needs to use a MessageJoiner
    this.msgSplitter = new MessageSplitter(provider.maxMsgSize ?? Infinity);
    this.msgJoiner = new MessageJoiner();

    this.log = Logger.create(this.ctx, LogSystem.Connection);

    this.ctx.maybeGet(ConnectionRecordSet)?.dispatchAdd(this);
  }

  protected override getThis() {
    return this;
  }

  sendReliable(data: Uint8Array) {
    if (this.isConnected) {
      try {
        for (const packet of this.msgSplitter.send(data)) {
          this.provider.sendReliable(packet);
        }
      } catch (err) {
        this.log?.error(`Caught error sending packet; closing connection: ${err}`, { err });
        this.close();
      }

      this.sendReliableCount++;
      this.ctx.maybeGet(ConnectionRecordSet)?.dispatchUpdate(this);
    }
  }

  sendFast(data: Uint8Array) {
    if (this.isConnected) {
      try {
        for (const packet of this.msgSplitter.send(data)) {
          this.provider.sendFast(packet);
        }
      } catch (err) {
        this.log?.error(`Caught error sending packet; closing connection: ${err}`, { err });
        this.close();
      }

      this.sendFastCount++;
      this.ctx.maybeGet(ConnectionRecordSet)?.dispatchUpdate(this);
    }
  }

  close() {
    if (this.isConnected) {
      this.isConnected = false;
      this.provider.shutdown();

      this.ctx.get(ConnectionService).removeConnection(this);
      this.ctx.maybeGet(ConnectionRecordSet)?.dispatchRemove(this);

      // for (const fact of this.knownFacts) {
      //   fact.fromConnections = fact.fromConnections.filter((x) => x !== conn);
      //   fact.toConnections = fact.toConnections.filter((x) => x !== conn);
      // }
    }
  }

  recvData(data: Uint8Array) {
    this.recvCount++;
    this.lastRecvTimestamp = this.ctx.config.timeProvider.now();

    try {
      for (const msg of this.msgJoiner.recv(data)) {
        this.ctx.get(FactService).ingest(msg, FactSource.Remote, this);
      }
    } catch (err) {
      if (err instanceof BarrierException) {
        this.log?.debug(`Caught BarrierException ingesting fact: ${err}`, { err });
      } else {
        this.log?.error(`Error ingesting fact: ${err}`, { err });
        this.close();
      }
    }

    this.ctx.maybeGet(ConnectionRecordSet)?.dispatchUpdate(this);
  }
}
