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
import { GeneratorContract } from './GeneratorContract.ts';
import { NameContract } from './NameContract.ts';

export const makeDefaultContractProviders = (): ContractProvider<unknown>[] => [
  BurnContract,
  RootContract,
  DataContract,
  AccountContract,
  TimeContract,
  FrontierContract,
  CollateralContract,
  TrueContract,
  CollatzContract,
  GeneratorContract,
  NameContract,
];
