import { Hash } from "scaffold.io/util/Hash.ts";
import type { Contract } from "scaffold.io/contracts/Contract.ts";
import {
  AGGREGATION_CONTRACT,
  COLLATERAL_CONTRACT,
  INSURANCE_CONTRACT,
  RECORD_CONTRACT,
  SIGNATURE_CONTRACT,
} from "scaffold.io/core/Block.ts";
import { signatureContract } from "scaffold.io/contracts/SignatureContract.ts";
import { aggregationContract } from "scaffold.io/contracts/AggregationContract.ts";
import { collateralContract } from "scaffold.io/contracts/CollateralContract.ts";
import { insuranceContract } from "scaffold.io/contracts/InsuranceContract.ts";

const WELL_KNOWN: [Hash, string, Contract][] = [
  [SIGNATURE_CONTRACT, "Signature", signatureContract],
  [AGGREGATION_CONTRACT, "Aggregation", aggregationContract],
  [COLLATERAL_CONTRACT, "Collateral", collateralContract],
  [INSURANCE_CONTRACT, "Insurance", insuranceContract],
  [RECORD_CONTRACT, "Self", { run() {} }],
];

export function getContractName(hash: Hash): string | null {
  for (const [known, name] of WELL_KNOWN) {
    if (Hash.equals(hash, known)) return name;
  }
  return null;
}

export function getContract(hash: Hash): Contract | null {
  for (const [known, _, contract] of WELL_KNOWN) {
    if (Hash.equals(hash, known)) return contract;
  }
  return null;
}

export function getWellKnownContracts(): {
  hash: Hash;
  name: string;
  contract: Contract;
}[] {
  return WELL_KNOWN.map(([hash, name, contract]) => ({ hash, name, contract }));
}
