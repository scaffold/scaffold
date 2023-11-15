import Context from './Context.ts';
import { Block, BlockOutput, Verifier } from './messages.ts';
import BlockService from './BlockService.ts';
import BlockBuilder from '~/sbl/BlockBuilder.ts';

interface Entry {
  verifier: Verifier;
  amount: bigint;
  forceAfter: number;
}

// Perhaps IncentiveProvider?
export default class IncentiveService {
  constructor(private ctx: Context) {}

  public incentivize(
    verifier: Verifier,
    incentive: bigint,
    detail = new Uint8Array(),
    forceAfter = Date.now() + 1000,
  ) {
    if (incentive <= 0n) {
      return;
    }

    this.ctx.get(BlockBuilder).publish({
      outputs: [{ verifier, amount: incentive, detail }],
    }, 0);

    // if (amount > 0n) {
    //   this.ctx.get(PendingIncentiveRegistry).getOrCreate(
    //     Hash.digest(Verifier.encode(verifier)),
    //     () => ({ verifier, amount, forceAfter }),
    //     (entry) => {
    //       entry.amount += amount;
    //       entry.forceAfter = Math.min(entry.forceAfter, forceAfter);
    //       return entry;
    //     },
    //   );
    // }
  }

  public popIncentives(amount: bigint) {
    throw new Error(`Is this used?`);

    // const now = Date.now();
    // const sorted = this.ctx.get(PendingIncentiveRegistry).getAll()
    //   .sort((a, b) =>
    //     // Sort in order of increasing incentive
    //     // a.val.amount > b.val.amount ? 1 : a.val.amount < b.val.amount ? -1 : 0
    //     // Sort in order of force timestamp
    //     a.val.forceAfter > b.val.forceAfter
    //       ? 1
    //       : a.val.forceAfter < b.val.forceAfter
    //       ? -1
    //       : 0
    //   );

    // const res: BlockOutput[] = [];

    // while (amount > 0n) {
    //   const head = sorted.pop();
    //   if (!head) {
    //     res.push({
    //       verifier: this.ctx.get(AccountService).getNextAccountVerifier(),
    //       amount,
    //     });
    //     break;
    //   }

    //   if (head.val.amount <= amount) {
    //     amount -= head.val.amount;
    //     this.ctx.get(PendingIncentiveRegistry).pop(head.key);
    //     res.push(head.val);
    //   } else {
    //     head.val.amount -= amount;
    //     res.push({
    //       verifier: head.val.verifier,
    //       amount,
    //     });
    //     break;
    //   }
    // }

    // return res.map(({ verifier, amount }) => ({ verifier, amount: -amount }));

    return [];
  }
}
