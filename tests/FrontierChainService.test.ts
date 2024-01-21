import { assert } from '../test_deps.ts';
import { findOutput, makeTest, provideInitialBalance } from './util.ts';
import BlockBuilder from '../src/BlockBuilder.ts';
import WeightService from '../src/WeightService.ts';
import { BASE_WORK } from '../src/BlockService.ts';
import { EMPTY_ARR } from '../src/util/buffer.ts';
import { accountHash, frontierHash, trueHash } from '../src/constants.ts';
import { BlockVertex } from '../src/FrontierChainService.ts';
import { BlockFact } from '../src/FactMeta.ts';
import { ZERO_BLOCK } from '../src/BlockMeta.ts';
import FrontierChainService from '../src/FrontierChainService.ts';

const FRONTIER_OUTPUT = 0;
const OTHER_OUTPUT = 1;

const addVertex = (
  vote: BlockVertex | typeof ZERO_BLOCK | undefined,
  children?: BlockVertex[],
) => {
  const v: BlockVertex = {
    outputs: [{
      verifier: { contract_hash: frontierHash, params: EMPTY_ARR },
      amount: 10n,
      detail: EMPTY_ARR,
    }, {
      verifier: { contract_hash: trueHash, params: EMPTY_ARR },
      amount: 10n,
      detail: EMPTY_ARR,
    }],
    outputClaims: [[]],
    frontierOutputIdx: FRONTIER_OUTPUT,
    frontierVoteBlock: vote as BlockVertex['frontierVoteBlock'],
  };

  for (const child of children ?? []) {
    child.outputClaims[FRONTIER_OUTPUT].push({
      block: v as BlockFact,
      inputIdx: 0,
    });
  }

  return v;
};

Deno.test(
  `[genesis] -> genesis`,
  makeTest({}, (_testCtx, ctx) => {
    const genesis = addVertex(ZERO_BLOCK);

    assert.assertStrictEquals(
      ctx.get(FrontierChainService).getMerger([
        { block: genesis, outputIdx: OTHER_OUTPUT },
      ]),
      genesis,
    );
  }),
);

Deno.test(
  `[genesis:F, v0:F] -> ZERO_BLOCK`,
  makeTest({}, (_testCtx, ctx) => {
    const genesis = addVertex(ZERO_BLOCK);
    const v0 = addVertex(genesis);

    assert.assertStrictEquals(
      ctx.get(FrontierChainService).getMerger([
        { block: genesis, outputIdx: FRONTIER_OUTPUT },
        { block: genesis, outputIdx: FRONTIER_OUTPUT },
      ]),
      ZERO_BLOCK,
    );
  }),
);
