import { assert, assertEquals, assertObjectMatch } from '@std/assert';
import { findOutput, makeTest, provideInitialBalance } from '../tests/util.ts';
import { BlockService } from '../src/BlockService.ts';
import { error } from '../src/util/functional.ts';
import { BlockBuilder } from '../src/BlockBuilder.ts';
import { Hash } from '../src/util/Hash.ts';
import { EMPTY_ARR } from '../src/util/buffer.ts';
import { frontierHash } from '../src/constants.ts';
import { ZERO_BLOCK } from '../src/BlockMeta.ts';

Deno.test(
  {
    name: `the genesis block should have a correct vote output detail`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [],
  }, (_testCtx, ctx) => {
    const genesisHash = provideInitialBalance(ctx);
    const genesis = ctx.get(BlockService).get(genesisHash, false) ??
      error(`Missing genesis block!`);

    assertObjectMatch(genesis.frontierDetail, {
      frontierVoteOutputCount: 0,
      subtreeSpentIdxs: [],
      subtreeOutputCount: 0,
    });
  }),
);

Deno.test(
  {
    name: `a voter should have a correct vote output detail`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [],
    enableFrontierVote: true,
  }, (_testCtx, ctx) => {
    const genesisHash = provideInitialBalance(ctx);
    const genesis = ctx.get(BlockService).get(genesisHash, false) ??
      error(`Missing genesis block!`);

    const block = ctx.get(BlockBuilder).publishSingleDraft({
      frontierVote: genesis,
    });

    assertObjectMatch(block.frontierDetail, {
      frontierVoteOutputCount: genesis.outputs.length,
      subtreeSpentIdxs: [],
      subtreeOutputCount: 0,
    });
  }),
);

Deno.test(
  {
    name: `a tree aggregator should have a correct vote output detail`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [],
    enableFrontierVote: true,
  }, (_testCtx, ctx) => {
    const genesisHash = provideInitialBalance(ctx);
    const genesis = ctx.get(BlockService).get(genesisHash, false) ??
      error(`Missing genesis block!`);

    const block1 = ctx.get(BlockBuilder).publishSingleDraft({
      frontierVote: genesis,
    });
    const block2 = ctx.get(BlockBuilder).publishSingleDraft({
      frontierVote: ZERO_BLOCK,
      inputs: [
        findOutput(genesis, frontierHash),
        findOutput(block1, frontierHash),
      ],
    });

    assertObjectMatch(block2.frontierDetail, {
      frontierVoteOutputCount: 0,
      subtreeSpentIdxs: [],
      subtreeOutputCount: genesis.outputs.length + block1.outputs.length -
        genesis.inputs.length -
        block1.inputs.length,
    });
  }),
);

Deno.test(
  {
    name: `a tree voter should have a correct vote output detail`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [],
    enableFrontierVote: true,
  }, (_testCtx, ctx) => {
    const genesisHash = provideInitialBalance(ctx);
    const genesis = ctx.get(BlockService).get(genesisHash, false) ??
      error(`Missing genesis block!`);

    const block1 = ctx.get(BlockBuilder).publishSingleDraft({
      frontierVote: genesis,
    });
    const block2 = ctx.get(BlockBuilder).publishSingleDraft({
      frontierVote: ZERO_BLOCK,
      inputs: [
        findOutput(genesis, frontierHash),
        findOutput(block1, frontierHash),
      ],
    });

    const treeBlocks = [genesis, block1, block2];
    const inputCount = treeBlocks.reduce((acc, x) => acc + x.inputs.length, 0);
    const outputCount = treeBlocks.reduce(
      (acc, x) => acc + x.outputs.length,
      0,
    );

    const block3 = ctx.get(BlockBuilder).publishSingleDraft({
      frontierVote: block2,
    });

    assertObjectMatch(block3.frontierDetail, {
      frontierVoteOutputCount: outputCount - inputCount,
      subtreeSpentIdxs: [],
      subtreeOutputCount: 0,
    });
  }),
);
