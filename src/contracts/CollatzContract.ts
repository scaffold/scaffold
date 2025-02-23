import { ComputationDriver } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { collatzHash } from '../hashes.ts';

export class CollatzContract implements ContractProvider {
  public contractHash = collatzHash;

  public async compute(driver: ComputationDriver) {
    driver.params.open('num').annotate(
      'The *number* we want the collatz sequence to start from',
      'text/prim/numeric/int',
    );

    const num = await driver.params.open('num').getBigInt();
    console.log(num);

    let answer;
    if (num === 1n) {
      answer = { stoppingTime: 0n, maximum: 1n };
    } else {
      const prev = driver.fetch(driver.contractHash, { num: num % 2n ? num * 3n + 1n : num / 2n });
      const prevStoppingTime = await prev.open('stoppingTime').getBigInt();
      const prevMaximum = await prev.open('maximum').getBigInt();
      answer = {
        stoppingTime: prevStoppingTime + 1n + (driver.emitCorrect() ? 0n : 1n),
        maximum: num > prevMaximum ? num : prevMaximum,
      };
    }

    driver.body.set(answer);
  }
}
