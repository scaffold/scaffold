import { Context } from './Context.ts';
import { ContractProvider } from './core/Contract.ts';
import { Contract, EnvContractProvider } from './core/EnvContractProvider.ts';
import { RoutingContractProvider } from './core/RoutingContractProvider.ts';
import { Hash } from './util/Hash.ts';

const demoContract: Contract = {
  run(env) {
    const name = new TextDecoder().decode(env.params());
    const response = new TextEncoder().encode(`Hello, ${name}`);
    env.setResult(response);
  },
};

export class DefaultContractProvider extends RoutingContractProvider implements ContractProvider {
  constructor(ctx: Context) {
    super(ctx, [{
      name: Hash.digest('demo'),
      provider: new EnvContractProvider(ctx, demoContract),
    }]);
  }
}
