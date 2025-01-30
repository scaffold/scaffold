import { Context } from './Context.ts';
import { BlockFact, Fact, FactSource, FactType } from './FactMeta.ts';
import { GenesisService } from './GenesisService.ts';
import { Connection, ConnectionService } from './ConnectionService.ts';
import { BlockService } from './BlockService.ts';
import { PeerManager } from './PeerManager.ts';
import { FactService } from './FactService.ts';
import { RandomSampler, SamplerState } from './util/RandomSampler.ts';
import { ContractClassifierService } from './ContractClassifierService.ts';
import { MaybePromise } from './util/MaybePromise.ts';
import { ClockService } from './ClockService.ts';
import { EmitterRecordSet } from './record_sets/EmitterRecordSet.ts';
import { signalPriorityResolution } from './SignalingService.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { BlockMetrics } from './BlockMetrics.ts';
import { EntropyProvider } from './Config.ts';

const packetOverheadBytes = 256;

export const emptyPoolSentinel = Symbol('EmptyPoolSentinel');
export const factGeneratorType = Symbol('FactGenerator');

export interface FactGenerator {
  describe(): {
    name: string;
    detail: string;
    emits: number;
  };
  estimateValue(): number;
  estimateSize(): number;
  generate(): MaybePromise<Fact | undefined>;
}

export type EmitterItem =
  | Fact
  | ({ type: typeof factGeneratorType } & FactGenerator)
  | typeof emptyPoolSentinel;

export class FactEmitter extends RandomSampler<EmitterItem> {
  private frontier = new Set<Fact>();
  private throttle = new Map<EmitterItem, number>();

  constructor(private ctx: Context) {
    super();

    this.ctx.get(ClockService).setPoissonInterval(() => this.emit(), 100);

    this.increaseWeight(emptyPoolSentinel);
  }

  public updateFrontier() {
    // const genesis = this.ctx.get(GenesisService).getGenesisBlock();
    // const queue = this.ctx.get(BlockMetrics).getDescendant(genesis).leaves;
    // this.frontier = new Set(queue);
    // for (let i = 0; i < queue.length; i++) {
    //   const vote = queue[i].parentBlock;
    //   if (
    //     vote !== undefined && vote !== ZERO_BLOCK && !this.frontier.has(vote)
    //   ) {
    //     this.frontier.add(vote);
    //     this.increaseWeight(vote);
    //     queue.push(vote);
    //   }
    // }
  }

  public notify(fact: Fact) {
    this.increaseWeight(fact);

    // TODO: Remove this
    for (const dst of this.getDestinations(fact)) {
      console.log(`Sending ${fact.hash.toHex()} to ${dst.name}`);
      this.ctx.get(FactService).sendTo(fact, dst);
    }
  }

  public addGenerator(generator: FactGenerator) {
    const item = Object.assign(generator, { type: factGeneratorType } as const);
    this.increaseWeight(item);
  }

  private async emit() {
    for (let i = 0; i < 2; i++) {
      const sample = this.sample();
      if (sample !== undefined) {
        if (sample.item === emptyPoolSentinel) {
          this.ctx.maybeGet(EmitterRecordSet)?.incrementSkip(sample.item);
          break;
        }

        const fact = sample.item.type === factGeneratorType
          ? await sample.item.generate()
          : sample.item;
        if (fact !== undefined) {
          const dst = this.getDestinations(fact).find((x) => !x.knownFacts.has(fact));
          if (dst !== undefined) {
            this.ctx.get(FactService).sendTo(fact, dst);
            this.throttle.delete(sample.item);
            this.ctx.maybeGet(EmitterRecordSet)?.incrementEmit(sample.item);
            continue;
          }
        }

        this.ctx.maybeGet(EmitterRecordSet)?.incrementSkip(sample.item);

        // mapPut(this.throttle, sample.item, () => 0.5, (x) => {
        //   x *= 0.5;
        //   console.warn(`Throttled to ${x}`);
        //   return x;
        // });
      }
    }
  }

  protected override randomNumber() {
    return this.ctx.config.entropyProvider.randomNumber();
  }

  public override weight(item: EmitterItem) {
    if (item === emptyPoolSentinel) {
      this.ctx.maybeGet(EmitterRecordSet)
        ?.update({ item, value: NaN, size: NaN, weight: 1 });
      return 1;
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

    const weight = value / (size + packetOverheadBytes);
    this.ctx.maybeGet(EmitterRecordSet)
      ?.update({ item, value, size, throttle, weight });

    return weight;
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

      for (const block of this.iterateConqueredBlocks(fact)) {
        for (const conn of block.fromConnections) {
          if (!conn.knownFacts.has(fact)) {
            value += Number(this.ctx.get(BlockMetrics).get(fact, 'selfWork'));
            // value += Number(this.ctx.get(BlockMetrics).getTreeChildrenWeight(fact));
          }
        }
        for (const conn of block.toConnections) {
          if (!conn.knownFacts.has(fact)) {
            value += Number(this.ctx.get(BlockMetrics).get(fact, 'selfWork'));
            // value += Number(this.ctx.get(BlockMetrics).getTreeChildrenWeight(fact));
          }
        }
      }

      if (this.ctx.get(FactService).isSignedByMe(fact)) {
        value += 256 * Number(this.ctx.get(BlockMetrics).get(fact, 'selfWork'));
      }

      if (this.frontier.has(fact)) {
        value += Number(this.ctx.get(BlockMetrics).get(fact, 'selfWork'));
        // value += Number(this.ctx.get(BlockMetrics).getTreeChildrenWeight(fact));
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
    } else if (fact.type === FactType.ConnectionSignal) {
      if (fact.toConnections.length >= 2) {
        return 0;
      }
      const dstFact = this.ctx.get(FactService).get(fact.replyTo, false);
      if (dstFact === undefined || dstFact.source === FactSource.Local) {
        return 0;
      }

      value += 1e5 * Math.pow(2, Math.min(fact.priority, 0) / signalPriorityResolution);
    } else if (fact.type === FactType.PeerInfo) {
      const publicKey = this.ctx.get(FactService).getPublicKey(fact);
      const peer = this.ctx.get(PeerManager).getPeer(publicKey);
      return peer?.clientInfoFacts.get(fact.clientNonce) === fact ? 1e5 : 0;
    } else if (this.ctx.get(FactService).isSignedByMe(fact)) {
      value += 1e5;
    } else {
      // TODO: Time since last identification packet?
      value += 1e5;
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

      for (const block of this.iterateConqueredBlocks(fact)) {
        conns.push(...block.fromConnections, ...block.toConnections);
      }

      return conns.concat(this.ctx.get(ConnectionService).getAll());
    } else if (fact.type === FactType.ConnectionSignal) {
      const dstFact = this.ctx.get(FactService).get(fact.replyTo, false);
      return dstFact !== undefined ? this.ctx.get(PeerManager).routeTo(dstFact) : [];
    } else {
      return this.ctx.get(ConnectionService).getAll();
    }
  }

  private *iterateConqueredBlocks(conqueror: BlockFact) {
    if (!conqueror.isCanonical) {
      return;
    }

    const queue = new Set<BlockFact>();
    for (const input of conqueror.inputs) {
      for (const claim of this.ctx.get(BlockService).getClaims(input)) {
        if (claim.block !== conqueror) {
          queue.add(claim.block);
        }
      }
    }

    for (const block of queue) {
      yield block;

      for (const voter of block.children) {
        queue.add(voter);
      }
      for (const claims of block.outputClaims) {
        for (const claim of claims) {
          queue.add(claim.block);
        }
      }
    }
  }
}
