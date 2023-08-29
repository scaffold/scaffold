import Context from './Context.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import { ANY_BODY_FLAG, LocalGeneratorOpts } from './LocalGeneratorService.ts';
import { TimeParams } from './messages.ts';
import Hash from './util/Hash.ts';
import { MaybePromise } from './util/types.ts';

// Only used in tests,
// Used to make sure that generating time contracts "out-of-spec" never wins.
export const enum TimeGeneratorModifier {
  None,
}

export default class TimeContract {
  constructor(private ctx: Context) {
    // ctx.get(LocalGeneratorService).addGenerator(
    //   timeHash,
    //   TimeContract.generate,
    // );
  }

  public async verify(
    params: Uint8Array,
    block: BlockFact,
    // request: (
    //   contractHash: Hash,
    //   params: Uint8Array,
    // ) => MaybePromise<Uint8Array>,
    _invert: (hash: Hash) => MaybePromise<Uint8Array>,
  ) {
    const { time } = TimeParams.decode(params);
    return block.timestamp >= time; // TODO: ===
  }

  public async generate(
    { params, emitCorrect }: LocalGeneratorOpts,
    modifier = TimeGeneratorModifier.None,
  ) {
    const { time } = TimeParams.decode(params);

    const wait = Number(time) - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    return ANY_BODY_FLAG;
  }
}
