import { Predicate } from '../../graph/types.ts';
import { bin2str, str2bin } from '../../util/buffer.ts';
import { Hash } from '../../util/Hash.ts';
import { Contract } from '../env/Contract.ts';
import { ParamsReader, serializeParams } from '../env/util/params.ts';

export const COUNTER_CONTRACT = Hash.digest('counter');

export interface CounterState {
  sum: number;
}

const initialState: CounterState = { sum: 0 };

export const counterInitPredicate: Predicate = {
  contract: COUNTER_CONTRACT,
  params: serializeParams(['init', 'chain']),
};
export const counterChainPredicate: Predicate = {
  contract: COUNTER_CONTRACT,
  params: serializeParams(['count', 'chain']),
};
export const counterIncrementPredicate: Predicate = {
  contract: COUNTER_CONTRACT,
  params: serializeParams(['count', 'inc']),
};

export const counterContract: Contract = {
  async run(env) {
    const params = new ParamsReader(env);
    const mode = params.read(0);

    if (mode === 'init') {
      // TODO: Add some kind of constraint so only one counter chain can be created
      env.send(counterChainPredicate, 0n, str2bin(JSON.stringify(initialState)));
      return;
    }

    // Claim a chain contract outputting a chain output
    const prevClaim = await env.claimOne(counterChainPredicate, counterChainPredicate);
    const prevState: CounterState = JSON.parse(bin2str(prevClaim.body));

    // Wait 100ms after the previous claim
    await env.waitUntil(prevClaim.blockTimestampMs + 1000);

    let totalAmount = prevClaim.amount;
    let newSum = prevState.sum;
    // Claim at least one
    for (
      const claim of [
        // await env.claimOne(counterIncrementPredicate),
        ...await env.claimAll(counterIncrementPredicate),
      ]
    ) {
      totalAmount += claim.amount;
      try {
        const inc = Number(JSON.parse(bin2str(claim.body)).inc);
        if (inc !== -1 && inc !== 1) {
          throw new Error(`Invalid increment: ${inc}`);
        }
        newSum += inc;
      } catch (err) {
        // TODO: env.debug()
        console.error(err);
      }
    }

    const newState: CounterState = { sum: newSum };
    env.send(counterChainPredicate, totalAmount, str2bin(JSON.stringify(newState)));
  },

  debug(params) {
    return `counter(${bin2str(params)})`;
  },
};
