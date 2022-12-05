import Hash from './util/Hash.ts';
import Context from './Context.ts';
import { Block, Claim, Incentive, Verifier } from './messages.ts';
import { BlockRegistry, IncentiveRegistry } from './registries.ts';
import IncentiveService from './IncentiveService.ts';
import IncentiveCalculator from './IncentiveCalculator.ts';

export default class BlockBuilder {
  constructor(private ctx: Context) {}

  public build(verifier: Verifier, body: Uint8Array): Block {
    const verifier_hash = Hash.digest(Verifier.encode(verifier));
    const claims = this.ctx.get(IncentiveRegistry).pop(verifier_hash) || [];
    const amount = this.ctx.get(IncentiveCalculator)
      .getAvailableIncentive(verifier, claims);
    const incentives = this.ctx.get(IncentiveService).popIncentives(amount);
    const timestamp = BigInt(Date.now());
    return { claims, incentives, verifier, body, timestamp };
  }
}
