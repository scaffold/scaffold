import { Context } from '../Context.ts';
import { Hash, HASH_SIZE, HashPrimitive } from '../util/Hash.ts';
import { FactService } from '../FactService.ts';
import { ComputationDriver, ComputationType } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { rootHash } from '../constants.ts';
import { mapPut } from '../util/map.ts';
import { arrEquals } from '../util/buffer.ts';
import { BlockService } from '../BlockService.ts';

export class RootContract implements ContractProvider {
  public contractHash = rootHash;

  private registry = new Map<HashPrimitive, Uint8Array>();

  public addData(data: Uint8Array) {
    const hash = Hash.digest(data);
    mapPut(this.registry, hash.toPrimitive(), () => data, (prevData) => {
      if (!arrEquals(prevData, data)) {
        throw new Error(`Internal error!`);
      }
      return prevData;
    });
    return hash;
  }

  public compute(driver: ComputationDriver, ctx: Context) {
    // TODO: How are errors handled here?
    const hash = Hash.fromBytes(driver.getParams());
    if (driver.type === ComputationType.Generator) {
      const data = this.registry.get(hash.toPrimitive());
      if (data !== undefined) {
        return driver.requireBody(data);
      }

      const fact = ctx.get(FactService).get(hash, false);
      if (fact) {
        return driver.requireBody(fact.data);
      }

      const got = ctx.get(BlockService)
        .getBlocksByVerifier(driver.getVerifier());
      if (got.length > 0) {
        return driver.requireBody(got[0].block.bodies[got[0].groupIdx]);
      }

      driver.ingenerable(`We don't know any data matching ${hash.toHex()}!`);
    } else if (driver.type === ComputationType.Contract) {
      const valid = Hash.equals(Hash.digest(driver.getBody()), hash);
      valid
        ? driver.pass()
        : driver.fail(`Given data doesn't hash to the correct value!`);
    }
  }
}
