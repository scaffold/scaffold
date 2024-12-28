import { ContractProvider } from '../SpecialContractManager.ts';
import { DataContract } from './DataContract.ts';
import { RootContract } from './RootContract.ts';
import { TimeContract } from './TimeContract.ts';
import { FrontierContract } from './FrontierContract.ts';
import { AccountContract } from './AccountContract.ts';
import { CollateralContract } from './CollateralContract.ts';
import { BurnContract } from './BurnContract.ts';
import { TrueContract } from './TrueContract.ts';
import { CollatzContract } from './CollatzContract.ts';

export const makeDefaultContractProviders = (): ContractProvider[] => [
  new BurnContract(),
  new RootContract(),
  new DataContract(),
  new AccountContract(),
  new TimeContract(),
  new FrontierContract(),
  new CollateralContract(),
  new TrueContract(),
  new CollatzContract(),
];
