import { assert, assertEquals, assertObjectMatch, assertThrows } from '@std/assert';
import { findOutput, makeTest, provideInitialBalance } from './util.ts';
import { BlockService } from '../src/BlockService.ts';
import { error } from '../src/util/functional.ts';
import { BlockBuilder } from '../src/BlockBuilder.ts';
import { Hash } from '../src/util/Hash.ts';
import { EMPTY_ARR } from '../src/util/buffer.ts';
import { encodeDataTree } from '../src/DataTreeHelper.ts';
import { frontierHash } from '../src/hashes.ts';
import { ZERO_BLOCK } from '../src/BlockMeta.ts';
import { FrontierService } from '../src/FrontierService.ts';

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

    assertEquals(ctx.get(FrontierService).getTotalUtxoCount(genesis), genesis.outputs.length);
    // assertObjectMatch(genesis.frontierDetail, {
    //   spentUtxoIdxs: [],
    //   subtreeNewUtxoCount: [],
    // });
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

    const block = ctx.get(BlockBuilder).publishSingleDraft({});

    assertEquals(
      ctx.get(FrontierService).getTotalUtxoCount(block),
      genesis.outputs.length - block.inputs.length + block.outputs.length,
    );
    // assertObjectMatch(block.frontierDetail, {
    //   spentUtxoIdxs: [],
    //   subtreeNewUtxoCount: [],
    // });
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

    const block1 = ctx.get(BlockBuilder).publishSingleDraft({});
    const block2 = ctx.get(BlockBuilder).publishSingleDraft({
      groupIdx: 0,
      inputs: [
        findOutput(genesis, frontierHash),
        findOutput(block1, frontierHash),
      ],
    });

    assertEquals(
      ctx.get(FrontierService).getTotalUtxoCount(block2),
      genesis.outputs.length -
        block1.inputs.length + block1.outputs.length -
        block2.inputs.length + block2.outputs.length,
    );
    // assertObjectMatch(block2.frontierDetail, {
    //   spentUtxoIdxs: [],
    //   subtreeNewUtxoCount: [genesis.outputs.length - block1.inputs.length, block1.outputs.length],
    // });
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

    const block1 = ctx.get(BlockBuilder).publishSingleDraft({});
    const block2 = ctx.get(BlockBuilder).publishSingleDraft({
      groupIdx: 0,
      inputs: [
        findOutput(genesis, frontierHash),
        findOutput(block1, frontierHash),
      ],
    });

    const block3 = ctx.get(BlockBuilder).publishSingleDraft({});

    assertEquals(
      ctx.get(FrontierService).getTotalUtxoCount(block3),
      genesis.outputs.length -
        block1.inputs.length + block1.outputs.length -
        block2.inputs.length + block2.outputs.length -
        block3.inputs.length + block3.outputs.length,
    );
    // assertObjectMatch(block3.frontierDetail, {
    //   spentUtxoIdxs: [],
    //   subtreeNewUtxoCount: [],
    // });
  }),
);

Deno.test(
  {
    name: `a double-spend should not be mergeable`,
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

    const contractHash = Hash.random();
    const emitter = ctx.get(BlockBuilder).publishSingleDraft({
      outputs: [
        {
          verifier: { contractHash, params: encodeDataTree(EMPTY_ARR) },
          amount: 100n,
          detail: encodeDataTree(EMPTY_ARR),
        },
      ],
    });

    const claimer1 = ctx.get(BlockBuilder).publishSingleDraft({
      inputs: [findOutput(emitter, contractHash)],
    });
    const claimer2 = ctx.get(BlockBuilder).publishSingleDraft({
      inputs: [findOutput(emitter, contractHash)],
    });

    assertThrows(() =>
      ctx.get(BlockBuilder).publishSingleDraft({
        inputs: [
          findOutput(claimer1, frontierHash),
          findOutput(claimer2, frontierHash),
        ],
      })
    );
  }),
);
