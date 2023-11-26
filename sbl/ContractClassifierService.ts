import Hash, { HashPrimitive } from './util/Hash.ts';
import Context from './Context.ts';
import {
  accountHash,
  burnHash,
  collateralHash,
  dataHash,
  frontierHash,
  jackpotHash,
  rootHash,
  timeHash,
  trueHash,
} from './constants.ts';
import { Verifier } from '~/sbl/messages.ts';

const toHashPrim = (x: string | Hash) =>
  (x instanceof Hash ? x : Hash.fromHex(x)).toPrimitive();

export default class ContractClassifierService {
  private immediatelyVerifiableContractHashes = new Set<HashPrimitive>(
    [accountHash, collateralHash, dataHash, frontierHash, rootHash, timeHash]
      .map(toHashPrim),
  );

  private freeMarketContractHashes = new Set<HashPrimitive>(
    [trueHash].map(toHashPrim),
  );

  private charityContractHashes = new Set<HashPrimitive>(
    [burnHash, jackpotHash].map(toHashPrim),
  );

  constructor(private ctx: Context) {}

  public isImmediatelyVerifiable({ contract_hash }: Verifier) {
    return this.immediatelyVerifiableContractHashes.has(
      contract_hash.toPrimitive(),
    );
  }

  public isFreeMarket({ contract_hash }: Verifier) {
    return this.freeMarketContractHashes.has(contract_hash.toPrimitive());
  }

  public isCharity({ contract_hash }: Verifier) {
    // TODO: Also return true if we're sending the funds back to an input signer, up to the input amount
    return this.charityContractHashes.has(contract_hash.toPrimitive());
  }
}
