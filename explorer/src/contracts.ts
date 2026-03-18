import { Hash } from "scaffold.io/util/Hash.ts";
import {
  AGGREGATION_CONTRACT,
  COLLATERAL_CONTRACT,
  RESULT_CONTRACT,
  SIGNATURE_CONTRACT,
} from "scaffold.io/core/Block.ts";

const WELL_KNOWN: [Hash, string][] = [
  [SIGNATURE_CONTRACT, "Signature"],
  [AGGREGATION_CONTRACT, "Aggregation"],
  [COLLATERAL_CONTRACT, "Collateral"],
  [RESULT_CONTRACT, "Self"],
];

export function getContractName(hash: Hash): string | null {
  for (const [known, name] of WELL_KNOWN) {
    if (Hash.equals(hash, known)) return name;
  }
  return null;
}
