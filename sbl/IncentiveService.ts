import Context from './Context.ts';
import Hash from './util/Hash.ts';
import { Incentive, Verifier } from './messages.ts';
import AccountService from './AccountService.ts';
import { getOrCreate } from './util/map.ts';

interface Entry {
  verifier: Verifier;
  amount: bigint;
  forceAfter: number;
}

// Perhaps IncentiveProvider?
export default class IncentiveService {
  private pending: Map<string, Entry> = new Map();

  constructor(private ctx: Context) {
    const itv = setInterval(() => this.forceIncentives(), 100);
    this.ctx.onDestruct(() => clearInterval(itv));
  }

  private forceIncentives() {
    const now = Date.now();
    const force: Incentive[] = [];
    this.pending.forEach((entry, key) => {
      if (entry.forceAfter < now) {
        force.push(entry);
        this.pending.delete(key);
      }
    });

    if (force.length) {
      this.ctx.get(AccountService).publishAnswer(force);
    }
  }

  public incentivize(
    verifier: Verifier,
    amount: bigint,
    forceAfter = Date.now() + 1000,
  ) {
    if (amount > 0n) {
      const key = Hash.digest(Verifier.encode(verifier)).toHex();
      getOrCreate(
        this.pending,
        key,
        () => ({ verifier, amount, forceAfter }),
        (entry) => {
          entry.amount += amount;
          entry.forceAfter = Math.min(entry.forceAfter, forceAfter);
          return entry;
        },
      );
    }
  }

  public popIncentives(amount: bigint) {
    const sorted = [...this.pending.entries()].sort((a, b) =>
      // Sort in order of increasing incentive
      // a[1].amount > b[1].amount ? 1 : a[1].amount < b[1].amount ? -1 : 0
      // Sort in order of force timestamp
      a[1].forceAfter > b[1].forceAfter
        ? 1
        : a[1].forceAfter < b[1].forceAfter
        ? -1
        : 0
    );

    const res: Incentive[] = [];

    while (amount > 0n) {
      const head = sorted.pop();
      if (!head) {
        res.push({
          verifier: this.ctx.get(AccountService).getNextAccountVerifier(),
          amount,
        });
        break;
      }
      const [key, entry] = head;

      if (entry.amount <= amount) {
        amount -= entry.amount;
        this.pending.delete(key);
        res.push(entry);
      } else {
        entry.amount -= amount;
        res.push({
          verifier: entry.verifier,
          amount,
        });
        break;
      }
    }

    return res;
  }
}
