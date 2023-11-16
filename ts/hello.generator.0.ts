import { LocalGenerator } from '../sbl/LocalGeneratorService.ts';
import { arrConcat, str2bin } from '../sbl/util/buffer.ts';

const gen: LocalGenerator = (driver, ctx) => {
  if (driver.emitCorrect()) {
    driver.requireBody(arrConcat(
      str2bin('Hello '),
      driver.getParams(),
      str2bin(' from '),
      str2bin(ctx.config.debugName),
      str2bin('!'),
    ));
  } else {
    driver.requireBody(str2bin('DUPE'));
  }
};

export default gen;
