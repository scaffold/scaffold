import { LocalGenerator } from '../sbl/LocalGeneratorService.ts';
import * as collatzMessages from './collatzMessages.ts';

/*
new Function(new TextDecoder().decode(Deno.readFileSync('./server/bootstrap/collatz.generator.0.js')))()({params: new Uint8Array([20]), emitCorrect: true})
*/

const gen: LocalGenerator = async (driver, ctx) => {
  // console.log(
  //   collatzMessages.Params.encode({ num: 10n }),
  // );

  const { num } = collatzMessages.Params.decode(driver.getParams());

  let answer: collatzMessages.Answer;
  if (num === 1n) {
    answer = { stopping_time: 0n, maximum: 1n };
  } else {
    const prev = collatzMessages.Answer.decode(
      await driver.request(
        driver.getContractHash(),
        collatzMessages.Params.encode({
          num: num % 2n ? num * 3n + 1n : num / 2n,
        }),
      ),
    );
    answer = {
      stopping_time: prev.stopping_time + 1n + (driver.emitCorrect() ? 0n : 1n),
      maximum: num > prev.maximum ? num : prev.maximum,
    };
  }

  driver.requireBody(collatzMessages.Answer.encode(answer));

  return;
};

export default gen;
