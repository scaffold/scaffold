import Context from './Context.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import {
  BlockFact,
  Collateralization,
  Fact,
  FactBase,
  FactSource,
  FactType,
} from './FactMeta.ts';
import BlockService from './BlockService.ts';
import NodeService, { Node } from './NodeService.ts';
import { Coder } from './messages.ts';
import secp from './util/secp.ts';
import * as zstd from 'https://deno.land/x/zstd_wasm@0.0.20/deno/zstd.ts';
import { arrEquals } from './util/buffer.ts';
import { error, todo } from './util/functional.ts';
import { mapPut } from './util/map.ts';
import * as log from 'std-latest/log/mod.ts';
import DataService from './DataService.ts';
import KeyService from './KeyService.ts';
import CollateralUtil, { DetailVote } from './CollateralUtil.ts';
import {
  adjectives,
  animals,
  colors,
  uniqueNamesGenerator,
} from 'unique-names-generator';
import SignalingService from './SignalingService.ts';
import ConnectionService from './ConnectionService.ts';

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
const headerSize = factMagic.byteLength + 1;

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

const invalidFact: unique symbol = Symbol('FactService.invalidFact');

export default class FactService {
  private factories: FactFactory[] = [];
  private ingestors: ((fact: FactBase) => void)[][] = [];
  private facts = new Map<HashPrimitive, Fact | typeof invalidFact>();

  private collateralByHash = new Map<HashPrimitive, Collateralization[]>();
  private validitiesByHash = new Map<
    HashPrimitive,
    Map<HashPrimitive, DetailVote>
  >();

  constructor(private ctx: Context) {
    for (let i = 0; i < 256; i++) {
      this.factories.push(() => {
        throw new Error(`Invalid message type ${i}!`);
      });
      this.ingestors.push([]);
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

  public registerIngestor<Type extends FactType>(
    type: Type,
    cb: (fact: FactBase & { type: Type }) => void,
  ) {
    this.ingestors[type].push(cb as (fact: FactBase) => void);
  }

  // public async init() {
  //   if (useZstd) {
  //     await zstd.init();
  //   }
  // }

  public has(hash: Hash) {
    const fact = this.facts.get(hash.toPrimitive());
    if (fact === invalidFact) {
      throw new Error(`Testing for existence of an ingesting or invalid fact!`);
    }
    return fact !== undefined;
  }

  public get(hash: Hash, request = true): Fact | undefined {
    const fact = this.facts.get(hash.toPrimitive());
    if (fact === invalidFact) {
      throw new Error(`Cannot get an ingesting or invalid fact!`);
    }
    if (fact === undefined && request) {
      this.ctx.get(DataService).request(hash);
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
      fact !== invalidFact && fact.type === FactType.Block && filter(fact)
        ? [fact]
        : []
    );
  }

  public addCollateral(blockHash: Hash, collateralization: Collateralization) {
    mapPut(this.collateralByHash, blockHash.toPrimitive(), () => [])
      .push(collateralization);
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
    this.facts.delete(fact.hash.toPrimitive());
    this.deleteFromStorage(fact);
  }

  public publish(fact: Fact) {
    if (fact.publishAt !== undefined && Date.now() < fact.publishAt) {
      throw new Error(`Trying to publish before publish time!`);
    }

    this.ctx.get(NodeService).getAll()
      .forEach((node) => this.sendTo(fact, node));
  }

  // TODO: RemoteNode
  public sendTo(fact: Fact, nodes: Node | Node[]) {
    if (fact.publishAt !== undefined && Date.now() < fact.publishAt) {
      throw new Error(`Trying to publish before publish time!`);
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

  public verify(fact: Pick<Fact, 'signer'>, publicKey: Uint8Array) {
    // const hash = Hash.digest(fact.data.subarray(0, -SIGNATURE_LENGTH));
    // return fact.signature !== undefined &&
    //   secp.verify(this.getSignature(fact), hash.toBytes(), publicKey);
    return arrEquals(fact.signer, publicKey);
  }
  public isSignedByMe(fact: Pick<Fact, 'signer'>) {
    return this.verify(fact, this.ctx.get(KeyService).getSelfPublicKey());
  }
  public getPublicKey(fact: Pick<Fact, 'signer'>) {
    return fact.signer;
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

    const hash = Hash.digest(data);
    const existing = this.facts.get(hash.toPrimitive());
    if (existing !== undefined) {
      if (existing === invalidFact) {
        throw new Error(`Cannot re-ingest an ingesting or invalid fact!`);
      }
      return existing;
    }

    if (this.facts.size >= this.ctx.config.limitFactCount) {
      throw new Error(
        `Hit the fact count limit of ${this.ctx.config.limitFactCount}!`,
      );
    }
    this.facts.set(hash.toPrimitive(), invalidFact);

    if (data.byteLength < headerSize) {
      throw new Error(`Message length (${data.byteLength}) is too short!`);
    }
    if (!arrEquals(data.subarray(0, factMagic.byteLength), factMagic)) {
      throw new Error(`Fact doesn't start with the magic bytes!`);
    }

    const type: FactType = data[factMagic.byteLength];
    const signed = typeHasSignature[type];
    if (signed && data.byteLength < SIGNATURE_LENGTH + headerSize) {
      throw new Error(`Message length (${data.byteLength}) is too short!`);
    }
    const signature = signed ? data.subarray(-SIGNATURE_LENGTH) : undefined;

    const base: FactBase = {
      hash,

      sillyName: this.getSillyName(),

      data,
      type,
      message: data.subarray(
        headerSize,
        signed ? -SIGNATURE_LENGTH : undefined,
      ),
      signature,

      source,
      signer: this.computePublicKey({ data, signature }),
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

      backtrace: new Error().stack,
    };

    const res = this.factories[base.type](base, mutator);
    if (res.type !== base.type) {
      throw new Error(
        `Factory ${base.type} returned incorrect message type ${res.type}!`,
      );
    }

    if (sortKeys) {
      Object.keys(res).sort().forEach((key) => {
        if (key !== 'type' && key !== 'sillyName') {
          const val = (res as Record<string, unknown>)[key];
          delete (res as Record<string, unknown>)[key];
          (res as Record<string, unknown>)[key] = val;
        }
      });
    }

    this.facts.set(hash.toPrimitive(), res);
    if (log.LogLevels.DEBUG >= this.ctx.config.logLevel) {
      console.log(`Created fact:`, res.hash.toHex(), res);
    } else if (log.LogLevels.INFO >= this.ctx.config.logLevel) {
      console.log(
        `Created ${res.type} fact from ${res.source}:`,
        res.hash.toHex(),
      );
    }

    this.writeToStorage(res);

    for (const cb of this.ingestors[base.type]) {
      cb(res);
    }

    this.ctx.get(NodeService).getOrCreate(res.signer).producedFacts.add(res);

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
    return uniqueNamesGenerator({
      dictionaries: [colors, animals],
      separator: '-',
    });
  }

  public snapshot() {
    return { facts: this.facts };
  }
}
