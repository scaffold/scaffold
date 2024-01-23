import { assert } from '../test_deps.ts';
import { findOutput, makeTest, provideInitialBalance } from './util.ts';
import BlockBuilder from '../src/BlockBuilder.ts';
import WeightService from '../src/WeightService.ts';
import { BASE_WORK } from '../src/BlockService.ts';
import { EMPTY_ARR } from '../src/util/buffer.ts';
import { accountHash, frontierHash, trueHash } from '../src/constants.ts';
import { BlockFact } from '../src/FactMeta.ts';
import { ZERO_BLOCK } from '../src/BlockMeta.ts';
import FrontierChainService from '../src/FrontierChainService.ts';
import Context from '../src/Context.ts';
import { FrontierTreeParams } from '../src/messages.ts';
import { arrEquals } from '../src/util/buffer.ts';
import Hash from '../src/util/Hash.ts';

const addBlock = (
  ctx: Context,
  vote: BlockFact | typeof ZERO_BLOCK | undefined,
  frontierChildren?: BlockFact[],
) => {
  let frontierLevel: number | undefined;
  const inputs = frontierChildren?.map((child) => {
    const output = child.outputs[child.frontierOutputIdx];

    const { level } = FrontierTreeParams.decode(output.verifier.params);
    if (frontierLevel === undefined) {
      frontierLevel = level;
    } else if (frontierLevel !== level) {
      throw new Error(`Cannot add children with different levels!`);
    }

    return {
      block: child,
      outputIdx: child.frontierOutputIdx,
      amount: output.amount,
    };
  });

  const block = ctx.get(BlockBuilder).publishSingleDraft({
    frontierVote: vote,
    frontierLevel: frontierLevel ?? 0,
    inputs,
    outputs: [{
      verifier: { contractHash: trueHash, params: EMPTY_ARR },
      amount: 10n,
      detail: EMPTY_ARR,
    }],
  });

  const otherOutputIdx = block.outputs.findIndex((x) =>
    Hash.equals(x.verifier.contractHash, trueHash)
  );
  return Object.assign(block, { otherOutputIdx });
};

Deno.test(
  `[genesis] -> genesis`,
  makeTest({ contractProviders: [] }, (_testCtx, ctx) => {
    const genesis = addBlock(ctx, ZERO_BLOCK);

    assert.assertStrictEquals(
      ctx.get(FrontierChainService).getVote([
        { block: genesis, outputIdx: genesis.otherOutputIdx },
      ]),
      genesis,
    );
  }),
);

Deno.test(
  `[genesis:F, v0:F] -> ZERO_BLOCK`,
  makeTest({}, (_testCtx, ctx) => {
    const genesis = addBlock(ctx, ZERO_BLOCK);
    const v0 = addBlock(ctx, genesis);

    assert.assertStrictEquals(
      ctx.get(FrontierChainService).getVote([
        { block: genesis, outputIdx: genesis.frontierOutputIdx },
        { block: genesis, outputIdx: genesis.frontierOutputIdx },
      ]),
      ZERO_BLOCK,
    );
  }),
);
