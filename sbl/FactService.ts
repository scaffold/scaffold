import Context from '~/sbl/Context.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import {
  BlockFact,
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

type FactFactory = (base: FactBase, node: Node) => Fact;

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

export default class FactService {
  private factories: FactFactory[] = [];
  private facts = new Map<HashPrimitive, Fact>();

  constructor(private ctx: Context) {
    for (let i = 0; i < 256; i++) {
      this.factories.push(() => {
        throw new Error(`Invalid message type ${i}!`);
      });
    }

    this.factories[FactType.Info] = (base, node) =>
      ctx.get(NodeService).createFact(base, node);
    this.factories[FactType.Block] = (base) =>
      ctx.get(BlockService).createFact(base);
    this.factories[FactType.BlockSet] = (base) =>
      ctx.get(BlockSetService).createFact(base);
    this.factories[FactType.BlockSetTreeNode] = (base) =>
      ctx.get(BlockSetService).createTreeNodeFact(base);
    this.factories[FactType.Frontier] = (base) =>
      ctx.get(FrontierService).createFact(base);
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

  public compose<MsgType>(msg: MsgType, coder: Coder<MsgType>, type: FactType) {
    const sign = typeHasSignature[type];

    let buf: Uint8Array;
    coder.encode(msg, (size) => {
      buf = new Uint8Array(size + (sign ? SIGNATURE_LENGTH + 1 : 1));
      return buf.subarray(1);
    });
    const data = buf!;

    data[0] = type;

    if (sign) {
      const size = data.byteLength - SIGNATURE_LENGTH;
      const sig = secp.sign(
        Hash.digest(data.subarray(0, size)).toBytes(),
        this.ctx.config.selfPrivateKey,
        { lowS: true, extraEntropy: secp.etc.randomBytes(32) },
      ).toCompactRawBytes();
      if (sig.byteLength !== SIGNATURE_LENGTH) {
        throw new Error(`Internal error: Unexpected signature length!`);
      }
      data.set(sig, size);
    }

    return useZstd ? zstd.compress(data, 10) : data;
  }

  // TODO: Test that whatever order we ingest blocks, it all ends up the same
  public ingest(data: Uint8Array, source: FactSource, fromNode: Node) {
    const fact = this.create(data, source, fromNode);

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

  private create(data: Uint8Array, source: FactSource, fromNode: Node): Fact {
    if (arrEquals(data.subarray(0, 4), zstdMagic)) {
      data = new Uint8Array(zstd.decompress(data));
    }

    const hash = Hash.digest(data);
    const existing = this.facts.get(hash.toPrimitive());
    if (existing) {
      return existing;
    }

    const type: FactType = data[0];
    const signed = typeHasSignature[data[0]];

    if (data.byteLength < (signed ? SIGNATURE_LENGTH + 1 : 1)) {
      throw new Error(`Message length (${data.byteLength}) is too short!`);
    }

    const base: FactBase = {
      hash,

      data,
      type,
      message: data.subarray(1, signed ? -SIGNATURE_LENGTH : undefined),
      signature: signed ? data.subarray(-SIGNATURE_LENGTH) : undefined,

      source,
      fromNodes: [],
      toNodes: [],

      backtrace: new Error().stack,
    };

    const res = this.factories[base.type](base, fromNode);
    if (res.type !== base.type) {
      throw new Error(
        `Factory ${base.type} returned incorrect message type ${res.type}!`,
      );
    }

    this.facts.set(hash.toPrimitive(), res);
    console.log(`Created fact:`, res.hash.toHex(), res);

    return res;
  }

  public snapshot() {
    return { facts: this.facts };
  }
}
