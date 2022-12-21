import Hash from './util/Hash.ts';
import Context from './Context.ts';
import { Block, Verifier } from './messages.ts';
import { BlockRegistry, IncentiveRegistry } from './registries.ts';
import IncentiveService from './IncentiveService.ts';
import IncentiveCalculator from './IncentiveCalculator.ts';

export default class BlockBuilder {
  constructor(private ctx: Context) {}

  public build(verifier: Verifier, body: Uint8Array): Block {
    const verifier_hash = Hash.digest(Verifier.encode(verifier));
    const inputs = this.ctx.get(IncentiveRegistry).pop(verifier_hash)?.inputs ||
      [];
    const amount = this.ctx.get(IncentiveCalculator)
      .getAvailableIncentive(verifier, inputs);
    const outputs = this.ctx.get(IncentiveService).popIncentives(amount);
    let timestamp = BigInt(Date.now());
    inputs.forEach((input) => {
      // TODO: No need to look these blocks up; just store them in IncentiveRegistry
      const inputTs =
        this.ctx.get(BlockRegistry).get(input.block_hash)!.timestamp;
      if (inputTs >= timestamp) {
        timestamp = inputTs + 1n;
      }
    });
    return { inputs, outputs, verifier, body, timestamp };
  }
}
