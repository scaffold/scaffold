import { assert } from './util/functional.ts';
import { Connection } from './Connection.ts';
import { Fact, FactRef, FactType, Reception } from './FactMeta.ts';
import { PoissonInterval } from './PoissonInterval.ts';
import { FactService } from './FactService.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { mapPop, mapPut } from './util/map.ts';
import { error } from './util/functional.ts';
import { HashInfo, Index } from './protocol/channel.ts';

// TODO: This is about 18 hours; increase it
const SAMPLE_EMIT_INIT = 0x4000000;

interface Sample {
  // How long can we wait and still be first?
  // This is populated via peer's feedback.
  // sentAt - recvAt - feebackDelay
  emitDelay: number;

  // How long did it take to receive notification the peer has received the Fact?
  // This is populated when we receive a Hash or Fact from the peer.
  recvDelay: number;
}

class Route {
  private samples: Sample[] = [];

  addSample(sample: Sample) {
    this.samples.push(sample);
  }

  getWinProb(delay: number) {
    let winCount = 1;
    let filteredCount = 1;

    for (const sample of this.samples) {
      if (sample.recvDelay >= delay) {
        if (sample.emitDelay >= delay) {
          winCount++;
        }
        filteredCount++;
      }
    }

    return winCount / filteredCount;
  }
}

const emitSampleCount = 4;

export class RoutingService {
  private incomingRoutes = new Map<Connection, Route>();
  private awaitingFeedback = new Map<HashPrimitive, Sample>();

  private factQueue: Fact[] = [];
  private bestFact?: Fact;

  private emitItvl: PoissonInterval;

  constructor(private conn: Connection) {
    this.emitItvl = new PoissonInterval(conn.ctx, () => this.emit(), 10);
  }

  enqueue(fact: Fact) {
    const now = this.conn.ctx.config.timeProvider.now();

    let full = false;
    if (this.bestFact === undefined) {
      if (this.canSend(fact, this.conn.ctx.config.timeProvider.now())) {
        // Send immediately
        full = true;
      } else {
        this.bestFact = fact;
      }
    } else {
      const bestEval = this.evaluate(this.bestFact, now);
      const factEval = this.evaluate(fact, now);
      if (factEval > bestEval) {
        if (this.canSend(fact, now, factEval)) {
          // Send immediately; don't replace bestFact
          full = true;
        } else {
          this.factQueue.push(this.bestFact);
          this.bestFact = fact;
        }
      } else {
        this.factQueue.push(fact);
      }
    }

    this.send(fact, now, full);
  }

  dequeue(fact: Fact) {
    if (this.bestFact === fact) {
      this.bestFact = undefined;
    } else {
      for (let i = 0; i < this.factQueue.length; i++) {
        if (this.factQueue[i] === fact) {
          const last = this.factQueue.pop()!;
          if (last !== fact) {
            this.factQueue[i] = last;
          }
          i--;
        }
      }
    }
  }

  addReception(fact: Fact | FactRef, full: boolean) {
    const timestamp = this.conn.ctx.config.timeProvider.now();

    if (full) {
      if (!fact.receptions.some((x) => x.full)) {
        for (const earlier of fact.receptions) {
          earlier.conn.get(RoutingService).sendIndex({
            hash: fact.hash,
            isRequest: null,
            lagMs: { int: earlier.timestamp - timestamp },
          });
        }
      }
    } else {
      const full = fact.receptions.find((x) => x.full);
      if (full !== undefined) {
        this.conn.get(RoutingService).sendIndex({
          hash: fact.hash,
          isRequest: null,
          lagMs: { int: timestamp - full.timestamp },
        });
      }
    }

    fact.receptions.push({ timestamp, conn: this.conn, full });
  }

  recvFeedback(hash: Hash, lagMs: number) {
    const sample = mapPop(this.awaitingFeedback, hash.toPrimitive());
    if (sample !== undefined) {
      sample.emitDelay -= SAMPLE_EMIT_INIT - lagMs;
    }
  }

  private emit(now?: number, bestEval?: number) {
    if (this.bestFact === undefined) {
      if (this.factQueue.length) {
        this.bestFact = this.factQueue.pop()!;
      } else {
        return;
      }
    }

    now ??= this.conn.ctx.config.timeProvider.now();
    bestEval ??= this.evaluate(this.bestFact, now);

    if (this.factQueue.length <= emitSampleCount) {
      for (const fact of this.factQueue) {
        assert(fact !== this.bestFact);

        const factEval = this.evaluate(fact, now);
        if (factEval > bestEval) {
          if (this.bestFact !== undefined) {
            this.factQueue.push(this.bestFact);
          }
          this.bestFact = fact;
          bestEval = factEval;
        }
      }
    } else {
      for (let i = 0; i < emitSampleCount; i++) {
        const idx = Math.floor(
          this.conn.ctx.config.entropyProvider.randomNumber() * this.factQueue.length,
        );
        const fact = this.factQueue[idx];
        assert(fact !== this.bestFact);

        const factEval = this.evaluate(fact, now);
        if (factEval > bestEval) {
          if (this.bestFact !== undefined) {
            this.factQueue.push(this.bestFact);
          }
          this.bestFact = fact;
          bestEval = factEval;
        }
      }
    }

    if (this.canSend(this.bestFact, now, bestEval)) {
      this.send(this.bestFact, now, true);
      this.bestFact = undefined;
    }
  }

  private evaluate(fact: Fact, now: number) {
    const value = 1.0;
    const route = this.incomingRoutes.get(fact.fromConnections[0]);
    const prob = route?.getWinProb(now - fact.receivedAt) ?? 1.0;
    return value * prob / (fact.data.byteLength + 256);
  }

  private canSend(fact: Fact, now: number, evaluation?: number) {
    return true;

    // if (fact.data.byteLength > this.conn.earnedBandwidth) {
    //   return false;
    // }

    // evaluation ??= this.evaluate(fact, now);
    // return evaluation >= 0.5;
  }

  private send(fact: Fact, now: number, full: boolean) {
    assert(!this.conn.knownFacts.has(fact));

    if (full) {
      this.conn.ctx.get(FactService).sendTo(fact, this.conn);
    } else {
      this.sendIndex({ hash: fact.hash, isRequest: { boolean: true }, lagMs: null });
    }

    const firstRecvAt = fact.receptions[0].timestamp;
    const sample: Sample = { emitDelay: SAMPLE_EMIT_INIT + now - firstRecvAt, recvDelay: 0 };

    const route = mapPut(this.incomingRoutes, fact.fromConnections[0], () => new Route());
    route.addSample(sample);

    mapPut(
      this.awaitingFeedback,
      fact.hash.toPrimitive(),
      () => sample,
      () => error(`Send called twice on the same hash!`),
    );

    fact.log?.info(
      `Sent ${full ? 'full' : 'index'} fact ${fact.hash.toHex()} to conn ${this.conn.sillyName}`,
    );
  }

  private sendIndex(info: HashInfo) {
    const data = this.conn.ctx.get(FactService).compose({ hashes: [info] }, Index, FactType.Index);
    this.conn.sendReliable(data);
  }
}
