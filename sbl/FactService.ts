import Context from '~/sbl/Context.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import {
  BlockFact,
  BlockSetFact,
  Collateralization,
  Fact,
  FactBase,
  FactSource,
  FactType,
} from '~/sbl/FactMeta.ts';
import BlockService from '~/sbl/BlockService.ts';
import NodeService, { Node } from '~/sbl/NodeService.ts';
import BlockSetService from '~/sbl/BlockSetService.ts';
import { Coder } from './messages.ts';
import secp from './util/secp.ts';
import FrontierService from '~/sbl/FrontierService.ts';
import * as zstd from 'https://deno.land/x/zstd_wasm@0.0.20/deno/zstd.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';
import { error } from '~/sbl/util/functional.ts';
import { getOrCreate } from '~/sbl/util/map.ts';

// TODO: We might have to update this to a fact-factory and a fact-ingestor
type FactFactory = (
  base: FactBase,
  node: Node,
  mutator?: (fact: Fact) => void,
) => Fact;

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

const factMagic = new Uint8Array([83, 66, 76]); // SBL
const headerSize = factMagic.byteLength + 1;

const SIGNATURE_LENGTH = 64; // We really shouldn't export this, since it's an implementation detail

const typeHasSignature: boolean[] = [];
typeHasSignature[FactType.Info] = true;
typeHasSignature[FactType.Block] = true;
typeHasSignature[FactType.BlockSet] = true;
typeHasSignature[FactType.BlockSetTreeNode] = false;
typeHasSignature[FactType.Frontier] = false;

const useZstd = false;
const zstdMagic = new Uint8Array([40, 181, 47, 253]);
(window as any).zstd = zstd;

const sortKeys = true;

export default class FactService {
  private factories: FactFactory[] = [];
  private facts = new Map<HashPrimitive, Fact>();

  private collateralByHash = new Map<HashPrimitive, Collateralization[]>();

  constructor(private ctx: Context) {
    for (let i = 0; i < 256; i++) {
      this.factories.push(() => {
        throw new Error(`Invalid message type ${i}!`);
      });
    }

    this.factories[FactType.Info] = (base, node, mutator) =>
      mutator !== undefined
        ? error(`Unexpected mutator`)
        : ctx.get(NodeService).createFact(base, node);
    this.factories[FactType.Block] = (base, _, mutator) =>
      mutator !== undefined
        ? error(`Unexpected mutator`)
        : ctx.get(BlockService).createFact(base);
    this.factories[FactType.BlockSet] = (base, _, mutator) =>
      ctx.get(BlockSetService).createFact(base, mutator);
    this.factories[FactType.BlockSetTreeNode] = (base, _, mutator) =>
      mutator !== undefined
        ? error(`Unexpected mutator`)
        : ctx.get(BlockSetService).createTreeNodeFact(base);
    // this.factories[FactType.Frontier] = (base, _, mutator) =>
    //   mutator !== undefined
    //     ? error(`Unexpected mutator`)
    //     : ctx.get(FrontierService).createFact(base);
  }

  // public async init() {
  //   if (useZstd) {
  //     await zstd.init();
  //   }
  // }

  public get(hash: Hash) {
    return this.facts.get(hash.toPrimitive());
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
      fact.type === FactType.Block && filter(fact) ? [fact] : []
    );
  }
  public hackyGetBlockSetsMatching(
    filter: (block: BlockSetFact) => boolean = () => true,
  ): BlockSetFact[] {
    return [...this.facts.values()].flatMap((fact) =>
      fact.type === FactType.BlockSet && filter(fact) ? [fact] : []
    );
  }

  public addCollateral(collateralization: Collateralization) {
    getOrCreate(
      this.collateralByHash,
      collateralization.params.block_hash.toPrimitive(),
      () => [],
    ).push(collateralization);
  }

  public compose<MsgType>(msg: MsgType, coder: Coder<MsgType>, type: FactType) {
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
      ).toCompactRawBytes();
      if (sig.byteLength !== SIGNATURE_LENGTH) {
        throw new Error(`Internal error: Unexpected signature length!`);
      }
      data.set(sig, size);
    }

    return useZstd ? zstd.compress(data, 10) : data;
  }

  // TODO: Test that whatever order we ingest blocks, it all ends up the same
  public ingest(
    data: Uint8Array,
    source: FactSource,
    fromNode: Node,
    mutator?: (fact: Fact) => void,
  ) {
    const fact = this.create(data, source, fromNode, mutator);

    fromNode.knownFacts.add(fact);
    fact.fromNodes.push(fromNode);

    return fact;
  }

  public publish(fact: Fact) {
    this.ctx.get(NodeService).getAll()
      .forEach((node) => this.sendTo(fact, node));
  }
  public sendTo(fact: Fact, node: Node) {
    if (!node.knownFacts.has(fact)) {
      node.knownFacts.add(fact);
      fact.toNodes.push(node);
      node.defaultConn?.sendReliable(fact.data);
    }
  }

  public verify(fact: Fact, publicKey: Uint8Array) {
    return fact.signature !== undefined &&
      secp.verify(fact.signature, fact.hash.toBytes(), publicKey);
  }
  public getPublicKey(fact: Fact) {
    if (fact.signature === undefined) {
      throw new Error(`No signature on fact!`);
    }
    return secp.Signature.fromCompact(fact.signature)
      .recoverPublicKey(fact.hash.toBytes()).toRawBytes();
  }

  private create(
    data: Uint8Array,
    source: FactSource,
    fromNode: Node,
    mutator?: (fact: Fact) => void,
  ): Fact {
    if (arrEquals(data.subarray(0, 4), zstdMagic)) {
      data = new Uint8Array(zstd.decompress(data));
    }

    const hash = Hash.digest(data);
    const existing = this.facts.get(hash.toPrimitive());
    if (existing) {
      return existing;
    }

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

    const base: FactBase = {
      hash,

      data,
      type,
      message: data.subarray(
        headerSize,
        signed ? -SIGNATURE_LENGTH : undefined,
      ),
      signature: signed ? data.subarray(-SIGNATURE_LENGTH) : undefined,

      source,
      fromNodes: [],
      toNodes: [],

      collateralizations: getOrCreate(
        this.collateralByHash,
        hash.toPrimitive(),
        () => [],
      ),

      backtrace: new Error().stack,
    };

    const res = this.factories[base.type](base, fromNode, mutator);
    if (res.type !== base.type) {
      throw new Error(
        `Factory ${base.type} returned incorrect message type ${res.type}!`,
      );
    }

    if (sortKeys) {
      Object.keys(res).sort().forEach((key) => {
        if (key !== 'type') {
          const val = (res as Record<string, unknown>)[key];
          delete (res as Record<string, unknown>)[key];
          (res as Record<string, unknown>)[key] = val;
        }
      });
    }

    this.facts.set(hash.toPrimitive(), res);
    console.log(`Created fact:`, res.hash.toHex(), res);

    return res;
  }

  public snapshot() {
    return { facts: this.facts };
  }
}
