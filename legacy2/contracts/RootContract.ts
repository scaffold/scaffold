import { FactService } from '../FactService.ts';
import { ComputationDriver, ComputationType } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { rootHash } from '../hashes.ts';
import { encodeDataTree } from '../DataTreeHelper.ts';
import { DataService } from '../DataService.ts';
import { Hash } from '../util/Hash.ts';

export const RootContract: ContractProvider<Hash> = {
  name: 'root',
  contractHash: rootHash,

  encodeParams: encodeDataTree,

  async compute(driver) {
    // TODO: How are errors handled here?
    const hash = await driver.params.getHash();
    if (driver.type === ComputationType.Generator) {
      const data = driver.ctx.get(DataService).getData(hash);
      if (data !== undefined) {
        return driver.body.setBytes(data);
      }

      const fact = driver.ctx.get(FactService).get(hash, false);
      if (fact) {
        return driver.body.setBytes(fact.data);
      }

      // const got = ctx.get(BlockService).getBlocksByVerifier(driver.getVerifier());
      // if (got.length > 0) {
      //   return driver.requireBody(got[0].block.bodies[got[0].groupIdx].value!.bytes);
      // }

      driver.ingenerable(`We don't know any data matching ${hash.toHex()}!`);
    } else if (driver.type === ComputationType.Contract) {
      const valid = Hash.equals(Hash.digest(await driver.body.getBytes()), hash);
      valid ? driver.pass() : driver.fail(`Given data doesn't hash to the correct value!`);
    }
  },
};
