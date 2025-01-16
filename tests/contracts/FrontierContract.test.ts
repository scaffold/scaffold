import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertStrictEquals,
} from '@std/assert';
import { makeTest, provideInitialBalance } from '../util.ts';
import { BlockBuilder } from '../../src/BlockBuilder.ts';
import { frontierHash } from '../../src/hashes.ts';
import { BlockService } from '../../src/BlockService.ts';
import { FrontierContract, frontierInputCount } from '../../src/contracts/FrontierContract.ts';
import { EMPTY_ARR } from '../../src/util/buffer.ts';
import { baseContractProviders, waitForVerifiedOutput } from '../../tests/contracts/util.ts';
import { FrontierTreeDetail, FrontierTreeParams } from '../../src/messages.ts';
import { FactService } from '../../src/FactService.ts';

const baseTreeDetail: FrontierTreeDetail = {
  treeWeights: [123n],
  spentUtxoIdxs: [],
  subtreeNewUtxoCount: [],
  consumedInputsRoot: { branches: [] },
  producedOutputsRoot: { branches: [] },
};

Deno.test(
  {
    name: `frontier contract no generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new FrontierContract()],
    allowSpecifiedFrontierOutputs: true,
  }, async (_testCtx, ctx1) => {
    const genesisHash = provideInitialBalance(ctx1);
    const genesisBlock = ctx1.get(BlockService).get(genesisHash)!;

    await waitForVerifiedOutput(ctx1, genesisBlock, frontierHash, false);
    assertEquals(ctx1.get(FactService).getSize(), 1);
  }),
);

Deno.test(
  {
    name: `frontier contract generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new FrontierContract()],
    allowSpecifiedFrontierOutputs: true,
  }, async (_testCtx, ctx1) => {
    const genesisHash = provideInitialBalance(ctx1);
    const genesisBlock = ctx1.get(BlockService).get(genesisHash)!;

    const incentiveBlocks = Array.from(
      { length: frontierInputCount - 1 },
      () =>
        ctx1.get(BlockBuilder).publishSingleDraft({
          groupIdx: 0,
          outputs: [{
            verifier: {
              contractHash: frontierHash,
              params: FrontierTreeParams.encode({ level: 0 }),
            },
            amount: 10n,
            detail: FrontierTreeDetail.encode(baseTreeDetail),
          }],
        }),
    );

    const genesisConsumer = await waitForVerifiedOutput(ctx1, genesisBlock, frontierHash, true);
    for (const block of incentiveBlocks) {
      const incentiveConsumer = await waitForVerifiedOutput(ctx1, block, frontierHash, true);
      assertStrictEquals(genesisConsumer!.block, incentiveConsumer!.block);
    }
    assertEquals(ctx1.get(FactService).getSize(), frontierInputCount + 1);
  }),
);

Deno.test(
  {
    name: `frontier contract validation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
    only: true,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new FrontierContract()],
    allowSpecifiedFrontierOutputs: true,
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const validBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      frontierLevel: 4,
      satisfies: Array.from({ length: frontierInputCount }, () => ({
        contractHash: frontierHash,
        params: FrontierTreeParams.encode({ level: 3 }),
        detail: FrontierTreeDetail.encode(baseTreeDetail),
      })),
    });

    assert(await ctx1.get(BlockService).waitForVerification(validBlock));
  }),
);

Deno.test(
  {
    name: `frontier contract invalidation by input count test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new FrontierContract()],
    allowSpecifiedFrontierOutputs: true,
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const invalidBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      frontierLevel: 4,
      satisfies: [{
        contractHash: frontierHash,
        params: FrontierTreeParams.encode({ level: 3 }),
        detail: FrontierTreeDetail.encode(baseTreeDetail),
      }],
    });

    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);

Deno.test(
  {
    name: `frontier contract invalidation by level test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new FrontierContract()],
    allowSpecifiedFrontierOutputs: true,
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const invalidBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      frontierLevel: 5,
      satisfies: [{
        contractHash: frontierHash,
        params: FrontierTreeParams.encode({ level: 3 }),
        detail: FrontierTreeDetail.encode(baseTreeDetail),
      }, {
        contractHash: frontierHash,
        params: FrontierTreeParams.encode({ level: 3 }),
        detail: FrontierTreeDetail.encode(baseTreeDetail),
      }],
    });

    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);
