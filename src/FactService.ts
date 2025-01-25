import { Context } from './Context.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { BlockFact, Collateralization, Fact, FactBase, FactSource, FactType } from './FactMeta.ts';
import { PeerManager } from './PeerManager.ts';
import { Coder } from './messages.ts';
import { secp } from './util/secp.ts';
import { zstd } from '../deps.ts';
import { arrEquals } from './util/buffer.ts';
import { error, todo } from './util/functional.ts';
import { mapPut } from './util/map.ts';
import * as log from '@std/log';
import { KeyService } from './KeyService.ts';
import { CollateralUtil, DetailVote } from './CollateralUtil.ts';
import { Connection, ConnectionService } from './ConnectionService.ts';
import { MonitoringService } from './MonitoringService.ts';
import { GarbageCollectionService } from './GarbageCollectionService.ts';
import { DataService } from './DataService.ts';
import { generateSillyName } from './util/sillyNameGenerator.ts';
import { FactEmitter } from './FactEmitter.ts';
import { ClockService } from './ClockService.ts';
import { IngestionProvider } from './IngestionProvider.ts';
import { BarrierException } from './exceptions.ts';
import { assert } from '@std/assert/assert';

const maxForgetDurationMs = 2500;

export const ingestingFact: unique symbol = Symbol('FactService.ingestingFact');

export const enum LoadFlags {
  MarkVisited = 1 << 0,
  RequestFromStorage = 1 << 1,
  RequestFromRemote = 1 << 2,
}

const factMagic = new Uint8Array([83, 66, 76]); // SBL == 0x53424c
export const headerSize = factMagic.byteLength + 1;

// Version by incrementing factMagic or creating a new FactType

const SIGNATURE_LENGTH = 64 + 1; // We shouldn't export this, since it's an implementation detail

const useZstd = false;
const zstdMagic = new Uint8Array([40, 181, 47, 253]);

const sortKeys = true;

export class FactService {
  private factories: IngestionProvider<Fact>[] = [];

  private facts = new Map<HashPrimitive, Fact | typeof ingestingFact>();

  private collateralByHash = new Map<HashPrimitive, Collateralization[]>();
  private validitiesByHash = new Map<HashPrimitive, Map<HashPrimitive, DetailVote>>();

  private pendingForgets: { fact: WeakRef<Fact>; forgetTimestamp: number }[] = [];
  private forgottenCount = 0;

  private nextFactIdx = 0;

  private isCreating = false;

  constructor(private ctx: Context) {
    for (const Provider of this.ctx.config.ingestionProviders) {
      const provider = this.ctx.get(Provider);
      this.factories[provider.type] = provider;
    }

    this.ingestFromStorage();

    this.ctx.get(ClockService).setPoissonInterval(() => {
      this.pendingForgets = this.pendingForgets.filter((pf) => {
        const fact = pf.fact.deref();
        if (fact === undefined) {
          this.forgottenCount++;
          return false;
        }

        return true;
      });

      if (this.pendingForgets.length > this.forgottenCount + 256) {
        console.warn(
          `There's ${this.pendingForgets.length} pending forgets but only ${this.forgottenCount} successfully forgotten facts!`,
        );
      }
    }, 1000);
  }

  public getSize() {
    return this.facts.size;
  }

  public getAll() {
    return this.facts;
  }

  // public async init() {
  //   if (useZstd) {
  //     await zstd.init();
  //   }
  // }

  public has(hash: Hash) {
    const fact = this.facts.get(hash.toPrimitive());
    if (fact === ingestingFact) {
      throw new Error(`Testing for existence of an ingesting fact!`);
    }
    return fact !== undefined;
  }

  public get(hash: Hash, request = true): Fact | undefined {
    const fact = this.facts.get(hash.toPrimitive());
    if (fact === ingestingFact) {
      throw new Error(`Cannot get an ingesting fact!`);
    }
    if (request) {
      if (fact !== undefined) {
        this.ctx.get(GarbageCollectionService).markVisited(fact);
      } else {
        this.ctx.get(DataService).request(hash);
      }
    }
    return fact;
  }
  public getAs<Type extends FactType>(
    hash: Hash,
    type: Type,
  ): Fact & { type: Type } {
    const fact = this.get(hash);
    if (fact?.type !== type) {
      throw new Error(`Invalid type ${fact?.type}`);
    }
    return fact as (Fact & { type: Type });
  }

  public hackyGetBlocksMatching(
    filter: (block: BlockFact) => boolean = () => true,
  ): BlockFact[] {
    return [...this.facts.values()].flatMap((fact) =>
      fact !== ingestingFact && fact.type === FactType.Block && filter(fact) ? [fact] : []
    );
  }

  public addCollateral(hash: Hash, collateralization: Collateralization) {
    mapPut(this.collateralByHash, hash.toPrimitive(), () => [])
      .push(collateralization);
    this.ctx.get(MonitoringService).collateralMonitor
      .callAll(hash, collateralization);
  }
  public forgetCollateral(hash: Hash, collateralBlock: BlockFact) {
    const colls = mapPut(this.collateralByHash, hash.toPrimitive(), () => []);
    const idx = colls.findIndex((coll) => coll.collateralBlock === collateralBlock);
    if (idx !== -1) {
      colls.splice(idx, 1);
    }
  }

  public increaseUsefulness(fact: Fact, usefulness: number) {
    if (usefulness > fact.usefulness && fact.fromConnections.length !== 0) {
      fact.fromConnections[0].earnedBandwidth += (usefulness - fact.usefulness) *
        this.ctx.config.bandwidthReciprocationUtilityFactor *
        fact.data.byteLength;
      fact.usefulness = usefulness;
    }
  }

  public getValidity(
    blockHash: Hash,
    hints: Uint8Array[],
  ): DetailVote | undefined {
    return this.validitiesByHash.get(blockHash.toPrimitive())
      ?.get(Hash.digestParts(...hints).toPrimitive());
  }
  public updateValidity(
    blockHash: Hash,
    hints: Uint8Array[],
    vote: DetailVote,
  ): DetailVote {
    return mapPut(
      mapPut(
        this.validitiesByHash,
        blockHash.toPrimitive(),
        () => new Map<HashPrimitive, DetailVote>(),
      ),
      Hash.digestParts(...hints).toPrimitive(),
      () => vote,
      (priorVote) => {
        const priorType = CollateralUtil.getContestType(priorVote);
        const newType = CollateralUtil.getContestType(vote);
        if (priorType !== newType) {
          throw new Error(`Cannot change the contest type!`);
        }

        if (priorVote.endsWith('_CONTEST')) {
          return vote;
        } else if (vote.endsWith('_CONTEST')) {
          return priorVote;
        } else if (vote !== priorVote) {
          throw new Error(
            `Cannot change a leaf result from ${priorVote} to ${vote}!`,
          );
        } else {
          return vote;
        }
      },
    );
  }

  public emit<Type extends FactType, MsgType>(
    msg: MsgType,
    coder: Coder<MsgType>,
    type: Type,
    publish?: boolean | Connection | Connection[],
    mutator?: (fact: Fact) => void,
  ) {
    // I know we're encoding/decoding redundantly here, and we can possibly make this faster later, but for now let's make everything go through the same code path
    const data = this.compose(msg, coder, type);
    const fact = this.ingest(data, FactSource.Local, undefined, mutator);
    if (fact.type !== type) {
      throw new Error(`Internal error! Invalid fact type ${fact.type}`);
    }
    if (publish === true) {
      this.publish(fact);
    } else if (publish) {
      this.sendTo(fact, publish);
    }
    return fact as Fact & { type: Type };
  }

  public compose<MsgType>(msg: MsgType, coder: Coder<MsgType>, type: FactType) {
    const provider = this.factories[type] ??
      error(`Invalid message type ${type}!`);

    let buf: Uint8Array;
    coder.encode(msg, (size) => {
      buf = new Uint8Array(size + (provider.isSigned ? SIGNATURE_LENGTH + headerSize : headerSize));
      return buf.subarray(headerSize);
    });
    const data = buf!;

    data.set(factMagic);
    data[factMagic.byteLength] = type;

    if (provider.isSigned) {
      const size = data.byteLength - SIGNATURE_LENGTH;
      const sig = secp.sign(
        Hash.digest(data.subarray(0, size)).toBytes(),
        this.ctx.config.selfPrivateKey,
        { lowS: true, extraEntropy: this.ctx.config.entropyProvider.randomBytes(32) },
      );
      const sigBytes = sig.toCompactRawBytes();
      if (sigBytes.byteLength !== SIGNATURE_LENGTH - 1) {
        throw new Error(`Internal error: Unexpected signature length!`);
      }
      data.set(sigBytes, size);

      if (
        sig.recovery !== 0 && sig.recovery !== 1 &&
        sig.recovery !== 2 && sig.recovery !== 3
      ) {
        throw new Error(`Invalid signature recovery bit ${sig.recovery}!`);
      }
      data[data.byteLength - 1] = sig.recovery;
    }

    return useZstd ? zstd.compress(data, 10) : data;
  }

  // TODO: Test that whatever order we ingest blocks, it all ends up the same
  public ingest(
    data: Uint8Array,
    source: FactSource,
    fromConn?: Connection,
    mutator?: (fact: Fact) => void,
  ) {
    const fact = this.create(data, source, mutator);

    // TODO: Send back "responses" here?

    if (fromConn !== undefined) {
      fromConn.knownFacts.add(fact);
      fact.fromConnections.push(fromConn);

      fromConn.earnedBandwidth += this.ctx.config.bandwidthReciprocationBaseFactor *
        fact.data.byteLength;
    }

    return fact;
  }

  public forget(fact: Fact) {
    const provider = this.factories[fact.type] ??
      error(`Invalid message type ${fact.type}!`);
    provider.forget(fact);

    if (fact.signer !== undefined) {
      this.ctx.get(PeerManager).getPeer(fact.signer)
        ?.producedFacts.delete(fact);
    }
    this.facts.delete(fact.hash.toPrimitive());
    this.deleteFromStorage(fact);

    this.pendingForgets.push({
      fact: new WeakRef(fact),
      forgetTimestamp: this.ctx.config.timeProvider.now(),
    });
  }

  public publish(fact: Fact, force = false) {
    if (fact.publishAt !== undefined && Date.now() < fact.publishAt && !force) {
      return;
    }

    // for (const node of this.ctx.get(NodeService).getAll()) {
    //   if (node.isRemote) {
    //     for (const conn of node.connections) {
    //       this.sendTo(fact, conn);
    //     }
    //   }
    // }

    this.ctx.get(FactEmitter).notify(fact);
  }

  public sendTo(fact: Fact, conns: Connection | Connection[]) {
    if (fact.publishAt !== undefined && Date.now() < fact.publishAt) {
      return;
    }

    for (const conn of Array.isArray(conns) ? conns : [conns]) {
      if (!conn.knownFacts.has(fact)) {
        conn.knownFacts.add(fact);
        fact.toConnections.push(conn);
        conn.sendReliable(fact.data);
      }
    }
  }

  public verify(fact: Pick<Fact, 'signer'>, publicKey: Uint8Array) {
    // const hash = Hash.digest(fact.data.subarray(0, -SIGNATURE_LENGTH));
    // return fact.signature !== undefined &&
    //   secp.verify(this.getSignature(fact), hash.toBytes(), publicKey);
    return fact.signer !== undefined && arrEquals(fact.signer, publicKey);
  }
  public isSignedByMe(fact: Pick<Fact, 'signer'>) {
    // TODO: Short-circuit by checking source?
    return this.verify(fact, this.ctx.get(KeyService).getSelfPublicKey());
  }
  public getPublicKey(fact: Pick<Fact, 'signer'>) {
    return fact.signer ?? error(`No signature on fact!`);
  }

  private computePublicKey(fact: Pick<Fact, 'data' | 'signature'>) {
    const hash = Hash.digest(fact.data.subarray(0, -SIGNATURE_LENGTH));
    return this.getSignature(fact).recoverPublicKey(hash.toBytes()).toRawBytes();
  }
  private getSignature(fact: Pick<Fact, 'signature'>) {
    if (fact.signature === undefined) {
      throw new Error(`No signature on fact!`);
    }
    return secp.Signature.fromCompact(fact.signature.subarray(0, SIGNATURE_LENGTH - 1))
      .addRecoveryBit(fact.signature[SIGNATURE_LENGTH - 1]);
  }

  private create(data: Uint8Array, source: FactSource, mutator?: (fact: Fact) => void): Fact {
    if (this.isCreating) {
      throw new Error(`Cannot create facts recursively!`);
    }
    this.isCreating = true;
    try {
      if (arrEquals(data.subarray(0, 4), zstdMagic)) {
        data = new Uint8Array(zstd.decompress(data));
      }

      if (data.byteLength < headerSize) {
        throw new Error(`Message length (${data.byteLength}) is too short!`);
      }
      if (!arrEquals(data.subarray(0, factMagic.byteLength), factMagic)) {
        throw new Error(`Fact doesn't start with the magic bytes!`);
      }

      const hash = Hash.digest(data);
      const existing = this.facts.get(hash.toPrimitive());
      if (existing !== undefined) {
        if (existing === ingestingFact) {
          throw new Error(`Cannot re-ingest an ingesting or invalid fact!`);
        }
        return existing;
      }

      const type: FactType = data[factMagic.byteLength];
      const provider = this.factories[type];
      if (provider === undefined) {
        throw new BarrierException(`Invalid message type ${type}!`);
      }

      if (provider.isPersistent && this.facts.size >= this.ctx.config.limitFactCount) {
        throw new Error(`Hit the fact count limit of ${this.ctx.config.limitFactCount}!`);
      }

      this.facts.set(hash.toPrimitive(), ingestingFact);

      if (provider.isSigned && data.byteLength < SIGNATURE_LENGTH + headerSize) {
        throw new Error(`Message length (${data.byteLength}) is too short!`);
      }
      const signature = provider.isSigned ? data.subarray(-SIGNATURE_LENGTH) : undefined;

      const fact = provider.create({
        hash,
        data,
        message: data.subarray(headerSize, provider.isSigned ? -SIGNATURE_LENGTH : undefined),

        signature,
        signer: provider.isSigned ? this.computePublicKey({ data, signature }) : undefined,

        receivedAt: this.ctx.config.timeProvider.now(),
        source,
        fromConnections: [],
        usefulness: 0,

        toConnections: [],

        collateralizations: mapPut(this.collateralByHash, hash.toPrimitive(), () => []),
        validities: mapPut(this.validitiesByHash, hash.toPrimitive(), () => new Map()),

        visitedAt: 0,
        references: 0,

        // Debugging stuff
        factIdx: this.nextFactIdx++,
        typeStr: FactType[type],
        sourceStr: FactSource[source],
        sillyName: generateSillyName(this.ctx.config.entropyProvider),
        backtrace: new Error().stack,
      });

      mutator?.(fact);

      if (sortKeys) {
        Object.keys(fact).sort().forEach((key) => {
          if (key !== 'typeStr' && key !== 'sourceStr' && key !== 'sillyName') {
            const val = (fact as any)[key];
            delete (fact as any)[key];
            (fact as any)[key] = val;
          }
        });
      }

      if (this.ctx.config.logLevel <= log.LogLevels.DEBUG) {
        console.log(`Created fact:`, fact.hash.toHex(), fact);
      } else if (this.ctx.config.logLevel <= log.LogLevels.INFO) {
        console.log(
          `Created ${FactType[fact.type]} fact from ${FactSource[fact.source]}:`,
          fact.hash.toHex(),
        );
      }

      if (provider.isPersistent) {
        this.facts.set(hash.toPrimitive(), fact);

        this.ctx.get(GarbageCollectionService).markVisited(fact);
        this.ctx.get(GarbageCollectionService).collect();

        this.writeToStorage(fact);

        if (fact.signer !== undefined) {
          this.ctx.get(PeerManager).putPeer(fact.signer).producedFacts.add(fact);
        }
      }

      provider.ingest(fact);

      return fact;
    } finally {
      assert(this.isCreating);
      this.isCreating = false;
    }
  }

  private writeToStorage(fact: Fact) {
    try {
      this.ctx.config.storageProvider.set(0, fact.hash, fact.data);
    } catch (err) {
      console.error(`Could not save fact ${fact.hash.toHex()} to storage:`, err);
    }
  }

  private deleteFromStorage(fact: Fact) {
    try {
      this.ctx.config.storageProvider.set(0, fact.hash);
    } catch (err) {
      console.error(`Could not delete fact ${fact.hash.toHex()} from storage:`, err);
    }
  }

  private async ingestFromStorage() {
    let count = 0;
    for await (const entry of this.ctx.config.storageProvider.list(0)) {
      try {
        this.create(entry.value, FactSource.Storage);
        count++;
      } catch (err) {
        console.error(`Could not ingest fact ${entry.key.toHex()} from storage:`, err);
      }
    }
    console.log(`Ingested ${count} facts from storage!`);
  }

  public snapshot() {
    return { facts: this.facts };
  }
}
