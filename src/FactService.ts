import { Context } from './Context.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import {
  BlockFact,
  Collateralization,
  Fact,
  FactBase,
  FactSource,
  FactType,
} from './FactMeta.ts';
import { BlockService } from './BlockService.ts';
import { Node, NodeService } from './NodeService.ts';
import { Coder } from './messages.ts';
import { secp } from './util/secp.ts';
import { zstd } from '../deps.ts';
import { arrEquals } from './util/buffer.ts';
import { error, todo } from './util/functional.ts';
import { mapPut } from './util/map.ts';
import { log } from '../deps.ts';
import { KeyService } from './KeyService.ts';
import { CollateralUtil, DetailVote } from './CollateralUtil.ts';
import { uniqueNamesGenerator } from '../deps.ts';
import { SignalingService } from './SignalingService.ts';
import { ConnectionService } from './ConnectionService.ts';
import { MonitoringService } from './MonitoringService.ts';
import { GarbageCollectionService } from './GarbageCollectionService.ts';
import { BlockRecordSet } from './record_sets/BlockRecordSet.ts';
import { UnspentOutputManager } from './UnspentOutputManager.ts';
import { BarrierException } from './exceptions.ts';
import { DataService } from './DataService.ts';

export const ingestingFact: unique symbol = Symbol('FactService.ingestingFact');

export const enum LoadFlags {
  MarkVisited = 1 << 0,
  RequestFromStorage = 1 << 1,
  RequestFromRemote = 1 << 2,
}

// TODO: We might have to update this to a fact-factory and a fact-ingestor
type FactFactory = (base: FactBase, mutator?: (fact: Fact) => void) => Fact;

// const enum A {
//   B,
//   C,
// }
// type X = { [x in A]: (y: x) => void } & any[];
// const a: X = [
//   (x) => x,
//   (x) => x,
// ];
// a.push(() => {});

const factMagic = new Uint8Array([83, 66, 76]); // SBL == 0x53424c
export const headerSize = factMagic.byteLength + 1;

// Version by incrementing factMagic or creating a new FactType

const SIGNATURE_LENGTH = 64 + 1; // We shouldn't export this, since it's an implementation detail
const SIGNATURE_RECOVERY_BIT = 64;

const typeHasSignature: boolean[] = [];
typeHasSignature[FactType.Identification] = true;
typeHasSignature[FactType.NodeInfo] = true;
typeHasSignature[FactType.InfoRequest] = false;
typeHasSignature[FactType.ConnectionSignal] = true;
typeHasSignature[FactType.Block] = true;
typeHasSignature[FactType.BlockSet] = true;
typeHasSignature[FactType.BlockSetTreeNode] = false;
typeHasSignature[FactType.MerkleTreeNode] = true;
typeHasSignature[FactType.Invalid] = true;

for (let i = 1; i < FactType._SIZE; i++) {
  if (typeHasSignature[i] === undefined) {
    throw new Error(`No typeHasSignature specified for ${i}!`);
  }
}

const useZstd = false;
const zstdMagic = new Uint8Array([40, 181, 47, 253]);
(window as any).zstd = zstd;

const sortKeys = true;

export class FactService {
  private factories: FactFactory[] = [];
  private ingestListeners: ((fact: unknown) => void)[][] = [];
  private forgetListeners: ((fact: unknown) => void)[][] = [];
  private facts = new Map<HashPrimitive, Fact | typeof ingestingFact>();

  private collateralByHash = new Map<HashPrimitive, Collateralization[]>();
  private validitiesByHash = new Map<
    HashPrimitive,
    Map<HashPrimitive, DetailVote>
  >();

  private nextFactIdx = 0;

  constructor(private ctx: Context) {
    for (let i = 0; i < 256; i++) {
      this.factories.push(() => {
        throw new Error(`Invalid message type ${i}!`);
      });
      this.ingestListeners.push([]);
      this.forgetListeners.push([]);
    }

    this.factories[FactType.Identification] = (base, mutator) =>
      mutator !== undefined
        ? error(`Unexpected mutator`)
        : ctx.get(ConnectionService).createIdentificationFact(base);
    this.factories[FactType.NodeInfo] = (base, mutator) =>
      mutator !== undefined
        ? error(`Unexpected mutator`)
        : ctx.get(NodeService).createInfoFact(base);
    this.factories[FactType.InfoRequest] = (base, mutator) =>
      mutator !== undefined
        ? error(`Unexpected mutator`)
        : ctx.get(NodeService).createRequestFact(base);
    this.factories[FactType.ConnectionSignal] = (base, mutator) =>
      mutator !== undefined
        ? error(`Unexpected mutator`)
        : ctx.get(SignalingService).createFact(base);
    this.factories[FactType.Block] = (base, mutator) =>
      ctx.get(BlockService).createFact(base, mutator);
    this.factories[FactType.BlockSet] = (base, mutator) => todo();
    this.factories[FactType.BlockSetTreeNode] = (base, mutator) => todo();
    this.factories[FactType.MerkleTreeNode] = todo;
    this.factories[FactType.Invalid] = (base, mutator) =>
      mutator !== undefined
        ? error(`Unexpected mutator`)
        : Object.assign(base, { type: FactType.Invalid as const });
    // this.factories[FactType.Frontier] = (base, _, mutator) =>
    //   mutator !== undefined
    //     ? error(`Unexpected mutator`)
    //     : ctx.get(FrontierService).createFact(base);

    this.ingestFromStorage();
  }

  public getSize() {
    return this.facts.size;
  }

  public getAll() {
    return this.facts;
  }

  public onIngest<Type extends FactType>(
    type: Type,
    cb: (fact: Fact & { type: Type }) => void,
  ) {
    this.ingestListeners[type].push(cb as (fact: unknown) => void);
  }
  public offIngest<Type extends FactType>(
    type: Type,
    cb: (fact: Fact & { type: Type }) => void,
  ) {
    const idx = this.ingestListeners[type]
      .lastIndexOf(cb as (fact: unknown) => void);
    if (idx === -1) {
      throw new Error(`Invalid listener`);
    }
    this.ingestListeners[type].splice(idx);
  }

  public onForget<Type extends FactType>(
    type: Type,
    cb: (fact: Fact & { type: Type }) => void,
  ) {
    this.forgetListeners[type].push(cb as (fact: unknown) => void);
  }
  public offForget<Type extends FactType>(
    type: Type,
    cb: (fact: Fact & { type: Type }) => void,
  ) {
    const idx = this.forgetListeners[type]
      .lastIndexOf(cb as (fact: unknown) => void);
    if (idx === -1) {
      throw new Error(`Invalid listener`);
    }
    this.forgetListeners[type].splice(idx);
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
      fact !== ingestingFact && fact.type === FactType.Block && filter(fact)
        ? [fact]
        : []
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
    const idx = colls.findIndex((coll) =>
      coll.collateralBlock === collateralBlock
    );
    if (idx !== -1) {
      colls.splice(idx, 1);
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
    publish?: boolean | Node | Node[],
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

  public compose<MsgType>(
    msg: MsgType,
    coder: Coder<MsgType>,
    type: FactType,
  ) {
    const sign = typeHasSignature[type];

    let buf: Uint8Array;
    coder.encode(msg, (size) => {
      buf = new Uint8Array(
        size + (sign ? SIGNATURE_LENGTH + headerSize : headerSize),
      );
      return buf.subarray(headerSize);
    });
    const data = buf!;

    data.set(factMagic);
    data[factMagic.byteLength] = type;

    if (sign) {
      const size = data.byteLength - SIGNATURE_LENGTH;
      const sig = secp.sign(
        Hash.digest(data.subarray(0, size)).toBytes(),
        this.ctx.config.selfPrivateKey,
        {
          lowS: true,
          extraEntropy: this.ctx.config.entropyProvider.randomBytes(32),
        },
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
    fromNode?: Node,
    mutator?: (fact: Fact) => void,
  ) {
    const fact = this.create(data, source, mutator);

    // TODO: Send back "responses" here?

    if (fromNode !== undefined && fromNode.isRemote) {
      fromNode.knownFacts.add(fact);
      fact.fromNodes.push(fromNode);
    }

    return fact;
  }

  public forget(fact: Fact) {
    for (const cb of this.forgetListeners[fact.type]) {
      cb(fact);
    }
    if (fact.type === FactType.Block) {
      this.ctx.get(BlockService).forget(fact);
      this.ctx.maybeGet(BlockRecordSet)?.dispatchRemove(fact);
    }
    if (fact.signer !== undefined) {
      this.ctx.get(NodeService).get(fact.signer)?.producedFacts.delete(fact);
    }
    this.facts.delete(fact.hash.toPrimitive());
    this.deleteFromStorage(fact);
  }

  public publish(fact: Fact, force = false) {
    if (fact.publishAt !== undefined && Date.now() < fact.publishAt && !force) {
      return;
    }

    this.ctx.get(NodeService).getAll()
      .forEach((node) => this.sendTo(fact, node));
  }

  // TODO: RemoteNode
  public sendTo(fact: Fact, nodes: Node | Node[]) {
    if (fact.publishAt !== undefined && Date.now() < fact.publishAt) {
      return;
    }

    for (const to of Array.isArray(nodes) ? nodes : [nodes]) {
      if (
        to.isRemote && !to.knownFacts.has(fact) && to.connections.size !== 0
      ) {
        to.knownFacts.add(fact);
        fact.toNodes.push(to);
        for (const conn of to.connections) {
          conn.sendReliable(fact.data);
        }
      }
    }
  }

  public replyTo(fact: Fact, reply: Fact) {
    this.sendTo(reply, fact.fromNodes);
  }

  public verify(fact: Pick<Fact, 'signer'>, publicKey: Uint8Array) {
    // const hash = Hash.digest(fact.data.subarray(0, -SIGNATURE_LENGTH));
    // return fact.signature !== undefined &&
    //   secp.verify(this.getSignature(fact), hash.toBytes(), publicKey);
    return fact.signer !== undefined && arrEquals(fact.signer, publicKey);
  }
  public isSignedByMe(fact: Pick<Fact, 'signer'>) {
    return this.verify(fact, this.ctx.get(KeyService).getSelfPublicKey());
  }
  public getPublicKey(fact: Pick<Fact, 'signer'>) {
    return fact.signer ?? error(`No signature on fact!`);
  }

  private computePublicKey(fact: Pick<Fact, 'data' | 'signature'>) {
    const hash = Hash.digest(fact.data.subarray(0, -SIGNATURE_LENGTH));
    return this.getSignature(fact)
      .recoverPublicKey(hash.toBytes()).toRawBytes();
  }
  private getSignature(fact: Pick<Fact, 'signature'>) {
    if (fact.signature === undefined) {
      throw new Error(`No signature on fact!`);
    }
    return secp.Signature.fromCompact(
      fact.signature.subarray(0, SIGNATURE_LENGTH - 1),
    ).addRecoveryBit(fact.signature[SIGNATURE_LENGTH - 1]);
  }

  private create(
    data: Uint8Array,
    source: FactSource,
    mutator?: (fact: Fact) => void,
  ): Fact {
    if (arrEquals(data.subarray(0, 4), zstdMagic)) {
      data = new Uint8Array(zstd.decompress(data));
    }

    const type: FactType = data[factMagic.byteLength];
    if (!this.ctx.config.enableBlockIngestion && type === FactType.Block) {
      throw new BarrierException(`Block ingestion disabled!`);
    }

    const hash = Hash.digest(data);
    const existing = this.facts.get(hash.toPrimitive());
    if (existing !== undefined) {
      if (existing === ingestingFact) {
        throw new Error(`Cannot re-ingest an ingesting or invalid fact!`);
      }
      return existing;
    }

    if (this.facts.size >= this.ctx.config.limitFactCount) {
      throw new Error(
        `Hit the fact count limit of ${this.ctx.config.limitFactCount}!`,
      );
    }
    this.facts.set(hash.toPrimitive(), ingestingFact);

    let res: Fact;
    try {
      if (data.byteLength < headerSize) {
        throw new Error(`Message length (${data.byteLength}) is too short!`);
      }
      if (!arrEquals(data.subarray(0, factMagic.byteLength), factMagic)) {
        throw new Error(`Fact doesn't start with the magic bytes!`);
      }

      const signed = typeHasSignature[type];
      if (signed && data.byteLength < SIGNATURE_LENGTH + headerSize) {
        throw new Error(`Message length (${data.byteLength}) is too short!`);
      }
      const signature = signed ? data.subarray(-SIGNATURE_LENGTH) : undefined;

      const base: FactBase = {
        hash,

        data,
        type,
        message: data.subarray(
          headerSize,
          signed ? -SIGNATURE_LENGTH : undefined,
        ),
        signature,

        receivedAt: this.ctx.config.timeProvider.now(),
        source,
        signer: signed ? this.computePublicKey({ data, signature }) : undefined,
        fromNodes: [],

        toNodes: [],

        collateralizations: mapPut(
          this.collateralByHash,
          hash.toPrimitive(),
          () => [],
        ),
        validities: mapPut(
          this.validitiesByHash,
          hash.toPrimitive(),
          () => new Map(),
        ),

        visitedAt: 0,
        references: 0,

        factIdx: this.nextFactIdx++,
        typeStr: FactType[type],
        sourceStr: FactSource[source],
        sillyName: this.getSillyName(),
        backtrace: new Error().stack,
      };

      res = this.factories[base.type](base, mutator);
      if (res.type !== base.type) {
        throw new Error(
          `Factory ${base.type} returned incorrect message type ${
            FactType[res.type]
          }!`,
        );
      }
    } catch (err) {
      console.info(err);
      this.facts.delete(hash.toPrimitive());
      throw err;
    }

    this.facts.set(hash.toPrimitive(), res);

    if (sortKeys) {
      Object.keys(res).sort().forEach((key) => {
        if (key !== 'typeStr' && key !== 'sourceStr' && key !== 'sillyName') {
          const val = (res as any)[key];
          delete (res as any)[key];
          (res as any)[key] = val;
        }
      });
    }

    if (log.LogLevels.DEBUG >= this.ctx.config.logLevel) {
      console.log(`Created fact:`, res.hash.toHex(), res);
    } else if (log.LogLevels.INFO >= this.ctx.config.logLevel) {
      console.log(
        `Created ${FactType[res.type]} fact from ${FactSource[res.source]}:`,
        res.hash.toHex(),
      );
    }

    this.ctx.get(GarbageCollectionService).markVisited(res);
    this.ctx.get(GarbageCollectionService).collect();

    this.writeToStorage(res);

    for (const cb of this.ingestListeners[res.type]) {
      cb(res);
    }

    if (res.type === FactType.Block) {
      this.ctx.get(BlockService).updateCanonicalities(
        this.hackyGetBlocksMatching(),
      );

      this.ctx.maybeGet(BlockRecordSet)?.dispatchAdd(res);

      this.ctx.get(UnspentOutputManager).tick();
    }

    if (res.signer !== undefined) {
      this.ctx.get(NodeService).getOrCreate(res.signer).producedFacts.add(res);
    }

    return res;
  }

  private writeToStorage(fact: Fact) {
    try {
      this.ctx.config.storageProvider.set(0, fact.hash, fact.data);
    } catch (err) {
      console.error(
        `Could not save fact ${fact.hash.toHex()} to storage:`,
        err,
      );
    }
  }

  private deleteFromStorage(fact: Fact) {
    try {
      this.ctx.config.storageProvider.set(0, fact.hash);
    } catch (err) {
      console.error(
        `Could not delete fact ${fact.hash.toHex()} from storage:`,
        err,
      );
    }
  }

  private async ingestFromStorage() {
    let count = 0;
    for await (const entry of this.ctx.config.storageProvider.list(0)) {
      try {
        this.create(entry.value, FactSource.Storage);
        count++;
      } catch (err) {
        console.error(
          `Could not ingest fact ${entry.key.toHex()} from storage:`,
          err,
        );
      }
    }
    console.log(`Ingested ${count} facts from storage!`);
  }

  private getSillyName() {
    return uniqueNamesGenerator.uniqueNamesGenerator({
      dictionaries: [uniqueNamesGenerator.colors, uniqueNamesGenerator.animals],
      separator: '-',
    });
  }

  public snapshot() {
    return { facts: this.facts };
  }
}
