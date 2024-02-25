import { Context } from './Context.ts';
import { BlockFact, Fact, FactType } from './FactMeta.ts';
import { GenesisService } from './GenesisService.ts';
import { WeightService } from './WeightService.ts';
import { Connection } from './ConnectionService.ts';
import { BlockService } from './BlockService.ts';
import { NodeService } from './NodeService.ts';
import { mapPut } from './util/map.ts';
import { FactService } from './FactService.ts';

const PACKET_OVERHEAD_BYTES = 256;

interface State {
  lastTimestamp: number;
  allowedBytes: number;
  queue: Set<Fact>;
  timeout?: number;
}

export class ConnectionGateway {
  private frontier = new Set<BlockFact>();

  private states = new Map<Connection, State>();

  constructor(private ctx: Context) {}

  public updateFrontier() {
    const genesis = this.ctx.get(GenesisService).getGenesisBlock();
    const queue = this.ctx.get(WeightService).getDescendant(genesis).leaves;
    const frontier = new Set(queue);
    for (let i = 0; i < queue.length; i++) {
      const vote = queue[i].frontierVoteBlock;
      if (vote !== undefined && !frontier.has(vote)) {
        queue.push(vote);
        frontier.add(vote);
      }
    }

    this.frontier = frontier;
  }

  // This should be called whenever the score returned by these arguments would increase
  public notify(fact: Fact, conn: Connection) {
    const state = mapPut(
      this.states,
      conn,
      (): State => ({
        lastTimestamp: this.ctx.config.timeProvider.now(),
        allowedBytes: 0,
        queue: new Set(),
      }),
    );
    state.queue.add(fact);

    this.wait(conn, state);
  }

  private wait(conn: Connection, state: State) {
    let bestFact: Fact | undefined;
    let bestScore = -Infinity;
    for (const fact of state.queue) {
      const score = this.score(fact, conn);
      if (score > bestScore) {
        bestFact = fact;
        bestScore = score;
      }
    }

    if (bestFact !== undefined) {
      const timeDelta = this.ctx.config.timeProvider.now() -
        state.lastTimestamp;
      const delay = timeDelta * this.ctx.config.baselineConnSendRate -
        state.allowedBytes;

      if (delay > 0) {
        this.ctx.config.timeProvider.setTimeout(
          () => this.wait(conn, state),
          delay,
        );
      } else {
        state.lastTimestamp += timeDelta;
        state.allowedBytes += timeDelta * this.ctx.config.baselineConnSendRate -
          bestFact.data.byteLength;
        this.ctx.get(FactService).sendTo(bestFact, conn);
        state.queue.delete(bestFact);
      }
    }
  }

  private score(fact: Fact, conn: Connection) {
    let value = 0;

    if (fact.type === FactType.Block) {
      if (this.frontier.has(fact)) {
        value += Number(fact.outputs[fact.frontierOutputIdx].amount);
      }

      for (const input of fact.inputs) {
        const block = this.ctx.get(BlockService).get(input.blockHash, false);
        if (block !== undefined && block.signer !== undefined) {
          const node = this.ctx.get(NodeService).get(block.signer);
          if (node !== undefined) {
            if (this.ctx.get(NodeService).pathTo(node) === conn) {
              value += Number(block.outputs[input.outputIdx].amount);
            }
          }
        }
      }
    } else {
      // TODO: Time since last identification packet?
      value = Infinity;
    }

    return value / (fact.data.byteLength + PACKET_OVERHEAD_BYTES);
  }
}
