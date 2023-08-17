import Context from '~/sbl/Context.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import { Fact, FactBase, FactSource, FactType } from '~/sbl/FactMeta.ts';
import BlockService from '~/sbl/BlockService.ts';
import { SIGNATURE_LENGTH } from '~/sbl/PacketCoder.ts';
import NodeService, { Node } from '~/sbl/NodeService.ts';
import BlockSetService from '~/sbl/BlockSetService.ts';

const errorFactory = () => {
  throw new Error(`Invalid message type!`);
};

type FactFactory = (base: FactBase, node: Node) => Fact;

export default class IngestionService {
  private factories: FactFactory[] = [];
  private facts = new Map<HashPrimitive, Fact>();

  constructor(private ctx: Context) {
    this.addFactory(
      FactType.Info,
      (base, node) => this.ctx.get(NodeService).createFact(base, node),
    );
    this.addFactory(
      FactType.Block,
      (base) => this.ctx.get(BlockService).createFact(base),
    );
    this.addFactory(
      FactType.BlockSet,
      (base) => this.ctx.get(BlockSetService).createFact(base),
    );
  }

  public get(hash: Hash) {
    return this.facts.get(hash.toPrimitive());
  }

  public compose() {
    // TODO: Use this instead of PacketCoder
  }

  // TODO: Test that whatever order we ingest blocks, it all ends up the same
  public ingest(data: Uint8Array, source: FactSource, fromNode: Node) {
    const fact = this.create(data, source, fromNode);

    fromNode.knownObjects.add(fact);
    fact.fromNodes.push(fromNode);

    return fact;
  }

  private addFactory(type: FactType, factory: FactFactory) {
    while (this.factories.length <= type) {
      this.factories.push(errorFactory);
    }
    this.factories[type] = factory;
  }

  private create(data: Uint8Array, source: FactSource, fromNode: Node): Fact {
    const hash = Hash.digest(data);
    const existing = this.facts.get(hash.toPrimitive());
    if (existing) {
      return existing;
    }

    if (data.byteLength < SIGNATURE_LENGTH + 1) {
      throw new Error(
        `Message length (${data.byteLength}) is not at least ${
          SIGNATURE_LENGTH + 1
        }`,
      );
    }

    const signature = data.subarray(0, SIGNATURE_LENGTH);
    const type: FactType = data[SIGNATURE_LENGTH];

    const base: FactBase = {
      hash,
      source,
      data,
      signature,
      fromNodes: [],
      toNodes: [],
      backtrace: new Error().stack,
    };

    const res = (this.factories[type] ?? errorFactory)(base, fromNode);
    if (res.type !== type) {
      throw new Error(
        `Factory ${type} returned incorrect message type ${res.type}!`,
      );
    }

    this.facts.set(hash.toPrimitive(), res);

    return res;
  }
}
