import { Context } from './Context.ts';
import { BlockFact, Fact, FactSource, FactType } from './FactMeta.ts';
import { GenesisService } from './GenesisService.ts';
import { WeightService } from './WeightService.ts';
import { Connection, ConnectionService } from './ConnectionService.ts';
import { BlockService } from './BlockService.ts';
import { PeerManager } from './PeerManager.ts';
import { mapPut } from './util/map.ts';
import { FactService } from './FactService.ts';
import { RandomSampler, SamplerState } from './util/RandomSampler.ts';
import { ContractClassifierService } from './ContractClassifierService.ts';
import { MaybePromise } from './util/MaybePromise.ts';
import { ClockService } from './ClockService.ts';

const packetOverheadBytes = 256;
const defaultExcessBytes = 65536;

const emptyPoolSentinel = Symbol('EmptyPoolSentinel');
const factGeneratorType = Symbol('FactGenerator');

interface FactGenerator {
  estimateValue(): number;
  estimateSize(): number;
  generate(): MaybePromise<Fact | undefined>;
}

type Item =
  | Fact
  | ({ type: typeof factGeneratorType } & FactGenerator)
  | typeof emptyPoolSentinel;

export class FactEmitter extends RandomSampler<Item> {
  private frontier = new Set<Fact>();
  private throttle = new Map<Item, number>();

  constructor(private ctx: Context) {
    super();

    this.ctx.get(ClockService).setPoissonInterval(() => this.emit(), 100);

    this.increaseWeight(emptyPoolSentinel);
  }

  public updateFrontier() {
    const genesis = this.ctx.get(GenesisService).getGenesisBlock();
    const queue = this.ctx.get(WeightService).getDescendant(genesis).leaves;
    this.frontier = new Set(queue);
    for (let i = 0; i < queue.length; i++) {
      const vote = queue[i].frontierVoteBlock;
      if (vote !== undefined && !this.frontier.has(vote)) {
        this.frontier.add(vote);
        this.increaseWeight(vote);
        queue.push(vote);
      }
    }
  }

  public notify(fact: Fact) {
    this.increaseWeight(fact);
  }

  public addGenerator(generator: FactGenerator) {
    this.increaseWeight(
      Object.assign(generator, { type: factGeneratorType } as const),
    );
  }

  private async emit() {
    for (let i = 0; i < 16; i++) {
      const sample = this.sample();
      if (sample !== undefined) {
        if (sample.item === emptyPoolSentinel) {
          break;
        }

        const fact = sample.item.type === factGeneratorType
          ? await sample.item.generate()
          : sample.item;
        if (fact !== undefined) {
          const dst = this.getDestinations(fact).find((x) =>
            !x.knownFacts.has(fact)
          );
          if (dst !== undefined) {
            this.ctx.get(FactService).sendTo(fact, dst);
            this.throttle.delete(sample.item);
            continue;
          }
        }

        // mapPut(this.throttle, sample.item, () => 0.5, (x) => {
        //   x *= 0.5;
        //   console.warn(`Throttled to ${x}`);
        //   return x;
        // });
      }
    }
  }

  protected override weight(item: Item) {
    if (item === emptyPoolSentinel) {
      return 1e-3;
    }

    let value: number;
    let size: number;
    if (item.type === factGeneratorType) {
      value = item.estimateValue();
      size = item.estimateSize();
    } else {
      value = this.evaluate(item);
      size = item.data.byteLength;
    }
    const throttle = this.throttle.get(item);
    if (throttle !== undefined) {
      value *= throttle;
    }
    return value / (size + packetOverheadBytes);
  }

  private evaluate(fact: Fact) {
    let value = 0;

    // if (this.getDestinations(fact).every((x) => x.knownFacts.has(fact))) {
    //   return 0;
    // }

    if (fact.type === FactType.Block) {
      if (fact.source === FactSource.Genesis) {
        return 0;
      }

      if (this.ctx.get(FactService).isSignedByMe(fact)) {
        value += 256 *
          Number(this.ctx.get(WeightService).getSelfWeight(fact).min);
      }

      if (this.frontier.has(fact)) {
        value += Number(this.ctx.get(WeightService).getSelfWeight(fact).min);
        value += Number(
          this.ctx.get(WeightService).getTreeChildrenWeight(fact),
        );
      }

      for (const input of fact.inputs) {
        const block = this.ctx.get(BlockService).get(input.blockHash, false);
        if (
          block !== undefined &&
          this.ctx.get(ContractClassifierService).isFreeMarket(
            block.outputs[input.outputIdx].verifier,
          )
        ) {
          value += Number(block.outputs[input.outputIdx].amount);
        }
      }
    } else if (this.ctx.get(FactService).isSignedByMe(fact)) {
      value += 1e2;
    } else {
      // TODO: Time since last identification packet?
      value += 1e1;
    }

    for (const conn of fact.toConnections) {
      value *= conn.reliability;
    }

    return value;
  }

  private getDestinations(fact: Fact) {
    if (fact.type === FactType.PeerInfo) {
      return this.ctx.get(ConnectionService).getAll();
    } else if (fact.type === FactType.Block) {
      const conns: Connection[] = [];
      for (const input of fact.inputs) {
        const block = this.ctx.get(BlockService).get(input.blockHash, false);
        if (
          block !== undefined &&
          this.ctx.get(ContractClassifierService).isFreeMarket(
            block.outputs[input.outputIdx].verifier,
          )
        ) {
          conns.push(...this.ctx.get(PeerManager).routeTo(block));
        }
      }
      return conns.concat(this.ctx.get(ConnectionService).getAll());
    } else {
      return this.ctx.get(ConnectionService).getAll();
    }
  }
}
