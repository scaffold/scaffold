import AccountContract from './AccountContract.ts';
import { BlockExt } from './BlockMeta.ts';
import CollateralContract from './CollateralContract.ts';
import {
  accountHash,
  collateralContestionHash,
  collateralHash,
  collateralInitHash,
  collateralVoteHash,
  dataHash,
  rootHash,
} from './constants.ts';
import Context from './Context.ts';
import DataContract from './DataContract.ts';
import RootContract from './RootContract.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import { MaybePromise } from './util/types.ts';

interface SpecialContract {
  verify(
    params: Uint8Array,
    block: BlockExt,
    invert: (hash: Hash) => MaybePromise<Uint8Array>,
  ): MaybePromise<boolean>;
}

export default class SpecialContractManager {
  private entries = new Map<HashPrimitive, SpecialContract>();

  constructor(private ctx: Context) {
    this.addSpecial(rootHash, RootContract);
    // this.addSpecial(dataHash, DataContract);
    this.addSpecial(collateralHash, CollateralContract);
    this.addSpecial(accountHash, AccountContract);
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
