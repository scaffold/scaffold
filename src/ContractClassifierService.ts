import { Hash, HashPrimitive } from './util/Hash.ts';
import { Context } from './Context.ts';
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
import { Verifier } from './messages.ts';

const toHashPrim = (x: string | Hash) => (x instanceof Hash ? x : Hash.fromHex(x)).toPrimitive();

export class ContractClassifierService {
  private immediatelyVerifiableContractHashes = new Set<HashPrimitive>(
    [accountHash, collateralHash, dataHash, frontierHash, rootHash, timeHash]
      .map(toHashPrim),
  );

  private freeMarketContractHashes = new Set<HashPrimitive>(
    [collateralHash, dataHash, frontierHash, rootHash, timeHash, trueHash]
      .map(toHashPrim),
  );

  private charityContractHashes = new Set<HashPrimitive>(
    [burnHash, jackpotHash].map(toHashPrim),
    // trueHash? It will be difficult to claim because of the self weight mechanics.
    // What if we don't even need a jackpot and just trueHash?
  );

  constructor(private ctx: Context) {}

  public isImmediatelyVerifiable({ contractHash }: Verifier) {
    return this.immediatelyVerifiableContractHashes.has(
      contractHash.toPrimitive(),
    );
  }

  public isFreeMarket({ contractHash }: Verifier) {
    return this.freeMarketContractHashes.has(contractHash.toPrimitive());
  }

  public isCharity({ contractHash }: Verifier) {
    // TODO: Also return true if we're sending the funds back to an input signer, up to the input amount
    // ^ Actually DON'T do this!!!
    // Artificially-high-work blocks will lose money because they can be re-written for cheaper.
    // To ensure a claim, you must output a large amount to the jackpot.
    // Outputting to the input signer will go right back to the malicious actor & make this attack easy.

    return this.charityContractHashes.has(contractHash.toPrimitive());
  }
}
