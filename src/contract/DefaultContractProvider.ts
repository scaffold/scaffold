import { Context } from '../Context.ts';
import { ContractProvider } from './ContractProvider.ts';
import { EnvContractProvider } from './env/EnvContractProvider.ts';
import { RoutingContractProvider } from './RoutingContractProvider.ts';

import { AGGREGATION_CONTRACT, aggregationContract } from './static/Aggregation.ts';
import { SIGNATURE_CONTRACT, signatureContract } from './static/Signature.ts';
import { HELLO_CONTRACT, helloContract } from './static/Hello.ts';
import { BLOB_CONTRACT, blobContract } from './static/Blob.ts';
import { WasmContractProvider } from './wasm/WasmContractProvider.ts';
import { EXACT_BLOCK_CONTRACT, exactBlockContract } from './static/ExactBlock.ts';

export class DefaultContractProvider extends RoutingContractProvider implements ContractProvider {
  constructor(ctx: Context) {
    super(ctx, [{
      hash: AGGREGATION_CONTRACT,
      provider: new EnvContractProvider(ctx, aggregationContract),
    }, {
      hash: SIGNATURE_CONTRACT,
      provider: new EnvContractProvider(ctx, signatureContract),
    }, {
      hash: HELLO_CONTRACT,
      provider: new EnvContractProvider(ctx, helloContract),
    }, {
      hash: BLOB_CONTRACT,
      provider: new EnvContractProvider(ctx, blobContract),
    }, {
      hash: EXACT_BLOCK_CONTRACT,
      provider: new EnvContractProvider(ctx, exactBlockContract),
    }], new WasmContractProvider(ctx));
  }
}
