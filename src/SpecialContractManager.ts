import { Context } from './Context.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { MaybePromise } from './util/MaybePromise.ts';
import { ComputationDriver } from './ComputationMeta.ts';

export interface ContractProvider {
  readonly contractHash: Hash;

  compute(driver: ComputationDriver, ctx: Context): MaybePromise<void>;
}

// export class SpecialContractManager {
//   private entries = new Map<HashPrimitive, ContractProvider>();

//   constructor(private ctx: Context) {
//     for (const provider of ctx.config.contractProviders) {
//       this.addSpecial(provider);
//     }
//   }

//   private addSpecial(provider: ContractProvider) {
//     getOrCreate(
//       this.entries,
//       provider.contractHash.toPrimitive(),
//       () => provider,
//       (_) => {
//         throw new Error(
//           `Cannot add multiple local generators for contract ${provider.contractHash.toHex()}`,
//         );
//       },
//     );
//   }

//   public getContract(contractHash: Hash) {
//     return this.entries.get(contractHash.toPrimitive());
//   }
// }
