import { ContractProvider } from '~/sbl/SpecialContractManager.ts';
import DataContract from './DataContract.ts';
import RootContract from './RootContract.ts';
import TimeContract from './TimeContract.ts';
import FrontierContract from './FrontierContract.ts';
import AccountContract from './AccountContract.ts';
import CollateralContract from './CollateralContract.ts';
import BurnContract from '~/sbl/contracts/BurnContract.ts';
import TrueContract from '~/sbl/contracts/TrueContract.ts';

export const defaultContractProviders: ContractProvider[] = [
  // new BurnContract(),
  // new RootContract(),
  // new DataContract(),
  // new AccountContract(),
  // new TimeContract(),
  new FrontierContract(),
  // new CollateralContract(),
  new TrueContract(),
];
