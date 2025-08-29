import { assert, assertEquals, assertFalse } from '@std/assert';
import { makeTest, provideInitialBalance } from '../util.ts';
import { BlockBuilder } from '../../src/BlockBuilder.ts';
import { timeHash } from '../../src/hashes.ts';
import { BlockService } from '../../src/BlockService.ts';
import { TimeParams } from '../../src/messages.ts';
import { TimeContract } from '../../src/contracts/TimeContract.ts';
import { EMPTY_ARR } from '../../src/util/buffer.ts';
import { encodeDataTree } from '../../src/DataTreeHelper.ts';
import { baseContractProviders, waitForVerifiedOutput } from '../../tests/contracts/util.ts';

Deno.test(
  {
    name: `time contract generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, TimeContract],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const incentiveBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      outputs: [{
        verifier: {
          contractHash: timeHash,
          params: encodeDataTree(TimeParams.encode({ time: 123n })),
        },
        amount: 10n,
        detail: encodeDataTree(EMPTY_ARR),
      }],
    });

    await waitForVerifiedOutput(ctx1, incentiveBlock, timeHash, true);
  }),
);

Deno.test(
  {
    name: `time contract validation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, TimeContract],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const validBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      satisfies: [{
        contractHash: timeHash,
        params: encodeDataTree(TimeParams.encode({ time: 0n })),
      }],
    });

    assert(await ctx1.get(BlockService).waitForVerification(validBlock));
  }),
);

Deno.test(
  {
    name: `time contract invalidation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, TimeContract],
  }, async (_testCtx, ctx1, ctx2) => {
    provideInitialBalance(ctx1, ctx2);

    const invalidBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      satisfies: [{
        contractHash: timeHash,
        params: encodeDataTree(TimeParams.encode({ time: 123n })),
      }],
    });

    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);
