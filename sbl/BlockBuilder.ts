import Hash from './util/Hash.ts';
import Context from './Context.ts';
import { Block, Verifier } from './messages.ts';
import IncentiveService from './IncentiveService.ts';
// import IncentiveCalculator from './IncentiveCalculator.ts';
import BlockService from './BlockService.ts';
import { arrEquals } from './util/buffer.ts';

export default class BlockBuilder {
  constructor(private ctx: Context) {}

  public emit(
    block: Partial<Block>,
    satisfies: Verifier[],
    timeout = 0,
  ) {
    // 1. Gather all satisfying inputs that someone else could claim (which doesn't include signature satisfaction).
    // 2. For remaining output value, input to/from account balance.

    // const verifier_hash = Hash.digest(Verifier.encode(verifier));
    // const inputs = this.ctx.get(IncentiveRegistry).pop(verifier_hash)?.inputs ||
    //   [];
    const inputs = satisfies
      .flatMap((v) => this.ctx.get(BlockService).getBlocksByOutput(v))
      .flatMap(({ block, idx }) =>
        block.outputClaims[idx].length === 0 && block.outputs[idx].amount <= 0n
          ? [{
            block_hash: block.hash,
            output_idx: idx,
            amount: block.outputs[idx].amount,
          }]
          : []
      );
    const total = inputs.reduce((acc, cur) => acc + cur.amount, 0n);
    const outputs = this.ctx.get(IncentiveService).popIncentives(total);
    const side = true;
    const isFreeMarket = true;
    let timestamp = BigInt(Date.now());
    inputs.forEach((input) => {
      // TODO: No need to look these blocks up; just store them in IncentiveRegistry
      const inputTs =
        this.ctx.get(BlockService).get(input.block_hash)!.timestamp;
      if (inputTs >= timestamp) {
        timestamp = inputTs + 1n;
      }
    });
    return { inputs, outputs, body, side, isFreeMarket, timestamp };
  }
}
