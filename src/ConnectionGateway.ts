import { Context } from './Context.ts';
import { BlockFact, Fact, FactType } from './FactMeta.ts';
import { GenesisService } from './GenesisService.ts';
import { WeightService } from './WeightService.ts';
import { Connection } from './ConnectionService.ts';
import { BlockService } from './BlockService.ts';
import { PeerManager } from './PeerManager.ts';
import { mapPut } from './util/map.ts';
import { FactService } from './FactService.ts';

const PACKET_OVERHEAD_BYTES = 256;

interface State {
  nextSend: number;
  queue: Set<Fact>;

  timeoutAt?: number;
  timeoutHdl?: number;
}

export class ConnectionGateway {
  private frontier = new Set<Fact>();
  private publishQueue = new Set<Fact>();

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

    for (const [conn, state] of this.states) {
      this.enqueueSend(conn, state);
    }
  }

  public publish(fact: Fact, replaces?: Fact) {
    this.publishQueue.add(fact);

    for (const [conn, state] of this.states) {
      this.enqueueSend(conn, state);
    }
  }

  // This should be called whenever the score returned by these arguments would increase
  public notify(fact: Fact, conn: Connection) {
    if (conn.peer.knownFacts.has(fact)) {
      return;
    }

    const state = this.getState(conn);
    state.queue.add(fact);

    this.enqueueSend(conn, state);
  }

  public getState(conn: Connection) {
    return mapPut(
      this.states,
      conn,
      (): State => ({
        nextSend: this.ctx.config.timeProvider.now(),
        queue: new Set(),
      }),
    );
  }

  private enqueueSend(conn: Connection, state: State) {
    let bestFact: Fact | undefined;
    let bestScore = -Infinity;

    for (const fact of this.frontier) {
      if (!conn.peer.knownFacts.has(fact)) {
        const score = this.score(fact, conn);
        if (score > bestScore) {
          bestFact = fact;
          bestScore = score;
        }
      }
    }

    for (const fact of this.publishQueue) {
      if (!conn.peer.knownFacts.has(fact)) {
        const score = this.score(fact, conn);
        if (score > bestScore) {
          bestFact = fact;
          bestScore = score;
        }
      }
    }

    for (const fact of state.queue) {
      const score = this.score(fact, conn);
      if (score <= 0) {
        state.queue.delete(fact);
      } else if (score > bestScore) {
        bestFact = fact;
        bestScore = score;
      }
    }

    if (bestFact !== undefined) {
      const sendAt =
        bestFact.data.byteLength / this.ctx.config.baselineConnSendRate +
        state.nextSend;
      const now = this.ctx.config.timeProvider.now();
      const delay = sendAt - now;

      if (delay > 10) {
        if (sendAt !== state.timeoutAt) {
          if (state.timeoutHdl !== undefined) {
            this.ctx.config.timeProvider.clearTimeout(state.timeoutHdl);
          }

          state.timeoutAt = sendAt;
          state.timeoutHdl = this.ctx.config.timeProvider.setTimeout(() => {
            state.timeoutAt = undefined;
            state.timeoutHdl = undefined;
            this.enqueueSend(conn, state);
          }, delay);
        }
      } else {
        state.nextSend += bestFact.data.byteLength /
          this.ctx.config.baselineConnSendRate;
        if (state.nextSend < now - 60000) {
          state.nextSend = now - 60000;
        }
        this.ctx.get(FactService).sendTo(bestFact, conn);
        state.queue.delete(bestFact);

        this.enqueueSend(conn, state);
      }
    }
  }

  private score(fact: Fact, conn: Connection) {
    let value = 0;

    if (fact.type === FactType.Block) {
      if (this.ctx.get(FactService).isSignedByMe(fact)) {
        value += 256 * Math.pow(0.5, fact.toConnections.length) *
          Number(this.ctx.get(WeightService).getSelfWeight(fact).min);
      }

      if (this.frontier.has(fact)) {
        value += Number(fact.outputs[fact.frontierOutputIdx].amount);
      }

      for (const input of fact.inputs) {
        const block = this.ctx.get(BlockService).get(input.blockHash, false);
        if (block !== undefined && block.signer !== undefined) {
          const node = this.ctx.get(PeerManager).getPeer(block.signer);
          if (node !== undefined) {
            if (this.ctx.get(PeerManager).pathTo(node) === conn) {
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
