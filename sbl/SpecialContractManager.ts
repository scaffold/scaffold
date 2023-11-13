import {
  accountHash,
  dataHash,
  frontierHash,
  rootHash,
  timeHash,
} from './constants.ts';
import Context from './Context.ts';
import DataContract from './DataContract.ts';
import RootContract from './RootContract.ts';
import TimeContract from '~/sbl/TimeContract.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import { MaybePromise } from './util/types.ts';
import FrontierContract from './FrontierContract.ts';
import { ComputationDriver } from '~/sbl/WorkerLauncherService.ts';
import { getOrCreate } from '~/sbl/util/map.ts';
import AccountContract from '~/sbl/AccountContract.ts';

interface SpecialContract {
  compute(driver: ComputationDriver): MaybePromise<void>;
}

export default class SpecialContractManager {
  private entries = new Map<HashPrimitive, SpecialContract>();

  constructor(private ctx: Context) {
    this.addSpecial(rootHash, RootContract);
    this.addSpecial(dataHash, DataContract);
    // this.addSpecial(collateralHash, CollateralContract);
    this.addSpecial(accountHash, AccountContract);
    this.addSpecial(timeHash, TimeContract);
    // this.addSpecial(epochHash, EpochContract);
    this.addSpecial(frontierHash, FrontierContract);
  }

  private addSpecial(
    contractHash: Hash,
    Type: new (ctx: Context) => SpecialContract,
  ) {
    getOrCreate(
      this.entries,
      contractHash.toPrimitive(),
      () => this.ctx.get(Type),
      (_) => {
        throw new Error(
          `Cannot add multiple local generators for contract ${contractHash.toHex()}`,
        );
      },
    );
  }

  public getContract(contractHash: Hash) {
    return this.entries.get(contractHash.toPrimitive());
  }
}
