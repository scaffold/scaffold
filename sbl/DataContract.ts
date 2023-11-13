import Context from './Context.ts';
import FactService from '~/sbl/FactService.ts';
import { DataContractParams } from './messages.ts';
import NodeService from './NodeService.ts';
import Hash, { HASH_SIZE } from './util/Hash.ts';
import {
  ComputationDriver,
  ComputationType,
} from '~/sbl/WorkerLauncherService.ts';

// For easy-to-verify contracts in general:
//   Requestor asks for commitments. C(h, s) = c <-> HASH(plaintext) == h && HASH(plaintext | s | provider_public_key_hash) == c
//   The provider gives an initial claim of the validity of his commitment (collateral=1000).
//   Requestor challenges with a claim containing his payment (collateral=1).
//   In order to not lose his collateral, he must provide the plaintext as a hint.
//   It doesn't matter who steals/provides the plaintext, because the requestor claim payment always goes to the provider.

export default class DataContract {
  constructor(private ctx: Context) {}

  public compute(driver: ComputationDriver) {
    const { hash, secret } = DataContractParams.decode(driver.getParams());
    if (driver.type === ComputationType.Generator) {
      const fact = this.ctx.get(FactService).get(hash);
      if (fact) {
        if (driver.emitCorrect()) {
          const commitment = Hash.digestParts(
            fact.data,
            secret,
            this.ctx.get(NodeService).getSelfHash(),
          );
          driver.requireBody(commitment.toBytes());
        } else {
          driver.requireBody(Hash.random().toBytes());
        }
      } else {
        driver.ingenerable();
      }
    } else if (driver.type === ComputationType.Contract) {
      const body = driver.getBody();
      const hint = driver.getHint();
      const valid = body.byteLength === HASH_SIZE &&
        Hash.equals(Hash.digest(hint), hash) &&
        Hash.equals(
          Hash.digestParts(
            hint,
            secret,
            this.ctx.get(NodeService).getSelfHash(),
          ),
          Hash.fromBytes(body),
        );
      if (!valid) {
        driver.invalidate();
      }
    } else {
      throw new Error(`Invalid driver type!`);
    }
  }
}
