import { LocalGenerator } from '../sbl/LocalGeneratorService.ts';
import { str2bin } from '../sbl/pathUtils.ts';
import { arrConcat } from '../sbl/util/buffer.ts';

const gen: LocalGenerator = ({ ctx, params, emitCorrect }) =>
  emitCorrect
    ? arrConcat(
      str2bin('Hello '),
      params,
      str2bin(' from '),
      str2bin(ctx.config.debugName),
      str2bin('!'),
    )
    : str2bin('DUPE');

export default gen;
