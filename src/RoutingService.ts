import { Connection } from './ConnectionService.ts';
import { Context } from './Context.ts';
import { Fact } from './FactMeta.ts';
import { PeerUpdate } from './protocol/channel.ts';

interface PeerRequests {
  // categories: FactCategory[]

  nextCategory?: FactCategory;
  nextScore: number;

  getScoreThreshold(): number;
}

interface FactEmitter {
  parent: PeerRequests;

  weight: number;
  sourceMultiplier: Map<Connection, number>;

  nextFact?: Fact;
  nextScore: number;

  advance(): Fact;
}

interface FactCategory {
  emitters: FactEmitter[];

  evaluate(fact: Fact): number;
}

class RoutingService {
  private categories = new Map<string, FactCategory>();

  constructor(private ctx: Context) {}

  route(from: Connection, fact: Fact) {
    for (const key of this.classify(fact)) {
      const cat = this.categories.get(key);
      if (cat !== undefined) {
        const evaluation = cat.evaluate(fact);
        for (const emitter of cat.emitters) {
          const score = evaluation * emitter.weight * (emitter.sourceMultiplier.get(from) ?? 1);

          if (score >= emitter.parent.getScoreThreshold()) {
            this.emit(from, fact, emitter);
          } else if (score > emitter.nextScore) {
            emitter.nextFact = fact;
            emitter.nextScore = score;
            if (score > emitter.parent.nextScore) {
              emitter.parent.nextCategory = cat;
              emitter.parent.nextScore = score;
            }
          }
        }
      }
    }
  }

  update(update: PeerUpdate) {
    for (const item of update.updates) {
      item;
    }
  }

  private *classify(fact: Fact) {
    yield* `d${fact.hash.toHex()}`;
  }

  private emit(from: Connection, fact: Fact, emitter: FactEmitter) {}
}
