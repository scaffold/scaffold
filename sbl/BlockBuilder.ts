import Hash from './util/Hash.ts';
import Context from './Context.ts';
import { Block, Verifier } from './messages.ts';
import IncentiveService from './IncentiveService.ts';
// import IncentiveCalculator from './IncentiveCalculator.ts';
import BlockService from './BlockService.ts';
import { arrEquals } from './util/buffer.ts';

export default class BlockBuilder {
  constructor(private ctx: Context) {}

  public build(verifiers: Verifier[], body: Uint8Array): Block {
    // const verifier_hash = Hash.digest(Verifier.encode(verifier));
    // const inputs = this.ctx.get(IncentiveRegistry).pop(verifier_hash)?.inputs ||
    //   [];
    const inputs = verifiers
      .flatMap((v) => this.ctx.get(BlockService).getBlocksByOutput(v))
      .flatMap(({ block, idx }) =>
        block.outputClaims[idx].length === 0
          ? [{
            block_hash: block.hash,
            output_idx: idx,
            amount: block.outputs[idx].amount,
          }]
          : []
      );
    const amount = inputs.reduce((acc, cur) => acc + cur.amount, 0n);
    const outputs = this.ctx.get(IncentiveService).popIncentives(amount);
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
