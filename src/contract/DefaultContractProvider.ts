import { Context } from '../Context.ts';
import { ContractProvider } from './ContractProvider.ts';
import { EnvContractProvider } from './env/EnvContractProvider.ts';
import { RoutingContractProvider } from './RoutingContractProvider.ts';

import { AGGREGATION_CONTRACT, aggregationContract } from './static/Aggregation.ts';
import { SIGNATURE_CONTRACT, signatureContract } from './static/Signature.ts';
import { DEMO_CONTRACT, demoContract } from './static/Demo.ts';

export class DefaultContractProvider extends RoutingContractProvider implements ContractProvider {
  constructor(ctx: Context) {
    super(ctx, [{
      hash: AGGREGATION_CONTRACT,
      provider: new EnvContractProvider(ctx, aggregationContract),
    }, {
      hash: SIGNATURE_CONTRACT,
      provider: new EnvContractProvider(ctx, signatureContract),
    }, {
      hash: DEMO_CONTRACT,
      provider: new EnvContractProvider(ctx, demoContract),
    }]);
  }
}
