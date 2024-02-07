import { ComputationDriver } from '../ComputationMeta.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { collatzHash } from '../constants.ts';
import * as collatzMessages from './collatzMessages.ts';

export class CollatzContract implements ContractProvider {
  public contractHash = collatzHash;

  public async compute(driver: ComputationDriver) {
    const { num } = collatzMessages.Params.decode(driver.getParams());
    console.log(num);

    let answer: collatzMessages.Answer;
    if (num === 1n) {
      answer = { stopping_time: 0n, maximum: 1n };
    } else {
      const prev = collatzMessages.Answer.decode(
        await driver.fetch({
          contractHash: driver.getContractHash(),
          params: collatzMessages.Params.encode({
            num: num % 2n ? num * 3n + 1n : num / 2n,
          }),
        }),
      );
      answer = {
        stopping_time: prev.stopping_time + 1n +
          (driver.emitCorrect() ? 0n : 1n),
        maximum: num > prev.maximum ? num : prev.maximum,
      };
    }

    driver.requireBody(collatzMessages.Answer.encode(answer));
  }
}
