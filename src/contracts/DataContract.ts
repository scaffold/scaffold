import { Context } from '../Context.ts';
import { FactService } from '../FactService.ts';
import { DataContractParams } from '../messages.ts';
import { Hash, HASH_SIZE } from '../util/Hash.ts';
import { BurdenOfProof, ComputationDriver, ComputationType } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { dataHash } from '../hashes.ts';
import { KeyService } from '../KeyService.ts';

// For easy-to-verify contracts in general:
//   Requestor asks for commitments. C(h, s) = c <-> HASH(plaintext) == h && HASH(plaintext | s | provider_public_key_hash) == c
//   The provider gives an initial claim of the validity of his commitment (collateral=1000).
//   Requestor challenges with a claim containing his payment (collateral=1).
//   In order to not lose his collateral, he must provide the plaintext as a hint.
//   It doesn't matter who steals/provides the plaintext, because the requestor claim payment always goes to the provider.

export class DataContract implements ContractProvider {
  public contractHash = dataHash;

  public async compute(driver: ComputationDriver, ctx: Context) {
    const hash = await driver.params.open('hash').getHash();
    const secret = await driver.params.open('secret').getBytes();

    if (driver.type === ComputationType.Generator) {
      const fact = ctx.get(FactService).get(hash);
      if (fact) {
        if (driver.emitCorrect()) {
          const commitment = Hash.digestParts(
            fact.data,
            secret,
            ctx.get(KeyService).getSelfPublicKey(),
          );
          driver.body.setHash(commitment);
        } else {
          driver.body.setHash(Hash.random());
        }
      } else {
        driver.ingenerable(
          `We don't know any data matching the specified hash!`,
        );
      }
    } else if (driver.type === ComputationType.Contract) {
      const body = await driver.body.getBytes();
      const hint = await driver.getHint(0, BurdenOfProof.Validation).getBytes();
      const valid = body.byteLength === HASH_SIZE &&
        Hash.equals(Hash.digest(hint), hash) &&
        Hash.equals(
          Hash.digestParts(hint, secret, ctx.get(KeyService).getSelfPublicKey()),
          Hash.fromBytes(body),
        );
      valid ? driver.pass() : driver.fail(`Given data doesn't hash to the correct value!`);
    } else {
      throw new Error(`Invalid driver type!`);
    }
  }
}
