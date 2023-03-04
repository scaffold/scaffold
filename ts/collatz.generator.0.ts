import { LocalGenerator } from '../sbl/LocalGeneratorService.ts';
import * as collatzMessages from './collatzMessages.ts';

/*
new Function(new TextDecoder().decode(Deno.readFileSync('./server/bootstrap/collatz.generator.0.js')))()({params: new Uint8Array([20]), emitCorrect: true})
*/

const gen: LocalGenerator = async (
  { contractHash, params, emitCorrect, request },
) => {
  // console.log(
  //   collatzMessages.Params.encode({ num: 10n }),
  // );

  if (!emitCorrect) {
    return new TextEncoder().encode('DUPE');
  }

  const { num } = collatzMessages.Params.decode(params);

  let answer: collatzMessages.Answer;
  if (num === 1n) {
    answer = { stopping_time: 0n, maximum: 1n };
  } else {
    const prev = collatzMessages.Answer.decode(
      await request(
        contractHash,
        collatzMessages.Params.encode({
          num: num % 2n ? num * 3n + 1n : num / 2n,
        }),
      ),
    );
    answer = {
      stopping_time: prev.stopping_time + 1n + (emitCorrect ? 0n : 1n),
      maximum: num > prev.maximum ? num : prev.maximum,
    };
  }

  return collatzMessages.Answer.encode(answer);
};

export default gen;
