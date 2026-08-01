import { Context } from '../Context.ts';
import { ContractProvider } from './Contract.ts';
import { EnvContractProvider } from './EnvContractProvider.ts';
import { RoutingContractProvider } from './RoutingContractProvider.ts';
import { DEMO_CONTRACT, demoContract } from './static/Demo.ts';

export class DefaultContractProvider extends RoutingContractProvider implements ContractProvider {
  constructor(ctx: Context) {
    super(ctx, [{
      name: DEMO_CONTRACT,
      provider: new EnvContractProvider(ctx, demoContract),
    }]);
  }
}
