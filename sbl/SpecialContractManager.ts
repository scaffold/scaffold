import AccountContract from './AccountContract.ts';
import CollateralContract from './CollateralContract.ts';
import {
  accountHash,
  collateralHash,
  dataHash,
  epochHash,
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
import EpochContract from '~/sbl/EpochContract.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import FrontierContract from './FrontierContract.ts';
import { ComputationDriver } from '~/sbl/WorkerLauncherService.ts';

interface SpecialContract {
  compute(driver: ComputationDriver): Promise<void>;
}

export default class SpecialContractManager {
  private entries = new Map<HashPrimitive, SpecialContract>();

  constructor(private ctx: Context) {
    this.addSpecial(rootHash, RootContract);
    // this.addSpecial(dataHash, DataContract);
    // this.addSpecial(collateralHash, CollateralContract);
    // this.addSpecial(accountHash, AccountContract);
    this.addSpecial(timeHash, TimeContract);
    this.addSpecial(epochHash, EpochContract);
    this.addSpecial(frontierHash, FrontierContract);
  }

  private addSpecial(
    contractHash: Hash,
    Type: new (ctx: Context) => SpecialContract,
  ) {
    this.entries.set(contractHash.toPrimitive(), this.ctx.get(Type));
  }

  public getContract(contractHash: Hash) {
    return this.entries.get(contractHash.toPrimitive());
  }
}
