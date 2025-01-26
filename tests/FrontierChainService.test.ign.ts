import { assertEquals, assertStrictEquals } from '@std/assert';
import { findOutput, makeTest, provideInitialBalance } from './util.ts';
import { BlockBuilder } from '../src/BlockBuilder.ts';
import { BASE_WORK } from '../src/BlockService.ts';
import { EMPTY_ARR } from '../src/util/buffer.ts';
import { accountHash, frontierHash, trueHash } from '../src/hashes.ts';
import { BlockFact } from '../src/FactMeta.ts';
import { ZERO_BLOCK } from '../src/BlockMeta.ts';
import { FrontierChainService } from '../src/FrontierChainService.ts';
import { Context } from '../src/Context.ts';
import { FrontierTreeParams } from '../src/messages.ts';
import { arrEquals } from '../src/util/buffer.ts';
import { Hash } from '../src/util/Hash.ts';
import { GraphUtilityService } from '../src/GraphUtilityService.ts';

Deno.test(
  `[genesis] -> genesis`,
  makeTest({ contractProviders: [] }, (_testCtx, ctx) => {
    provideInitialBalance(ctx);

    const genesis = ctx.get(GraphUtilityService).addBlock(ZERO_BLOCK);

    assertStrictEquals(
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
    provideInitialBalance(ctx);

    const genesis = ctx.get(GraphUtilityService).addBlock(ZERO_BLOCK);
    const v0 = ctx.get(GraphUtilityService).addBlock(genesis);

    assertStrictEquals(
      ctx.get(FrontierChainService).getVote([
        { block: genesis, outputIdx: genesis.frontierOutputIdx },
        { block: genesis, outputIdx: genesis.frontierOutputIdx },
      ]),
      ZERO_BLOCK,
    );
  }),
);
