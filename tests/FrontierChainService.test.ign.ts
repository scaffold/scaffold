import { assertEquals, assertStrictEquals } from '@std/assert';
import { findOutput, makeTest, provideInitialBalance } from './util.ts';
import { BlockBuilder } from '../legacy2/BlockBuilder.ts';
import { BASE_WORK } from '../legacy2/BlockService.ts';
import { EMPTY_ARR } from '../src/util/buffer.ts';
import { accountHash, frontierHash, trueHash } from '../legacy2/hashes.ts';
import { BlockFact } from '../legacy2/FactMeta.ts';
import { ZERO_BLOCK } from '../legacy2/BlockMeta.ts';
import { FrontierChainService } from '../src/FrontierChainService.ts';
import { Context } from '../legacy2/Context.ts';
import { FrontierTreeParams } from '../legacy2/messages.ts';
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
