import { assert, assertEquals, assertFalse } from '@std/assert';
import { makeTest, provideInitialBalance } from '../util.ts';
import { BlockBuilder } from '../../src/BlockBuilder.ts';
import { trueHash } from '../../src/hashes.ts';
import { BlockService } from '../../src/BlockService.ts';
import { TrueContract } from '../../src/contracts/TrueContract.ts';
import { EMPTY_ARR } from '../../src/util/buffer.ts';
import { encodeDataTree } from '../../src/DataTreeHelper.ts';
import { baseContractProviders, waitForVerifiedOutput } from '../../tests/contracts/util.ts';

Deno.test(
  {
    name: `true contract generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, TrueContract],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const incentiveBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      outputs: [{
        verifier: { contractHash: trueHash, params: encodeDataTree(EMPTY_ARR) },
        amount: 10n,
        detail: encodeDataTree(EMPTY_ARR),
      }],
    });

    await waitForVerifiedOutput(ctx1, incentiveBlock, trueHash, true);
  }),
);

Deno.test(
  {
    name: `true contract validation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, TrueContract],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const validBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      satisfies: [{ contractHash: trueHash, params: encodeDataTree(EMPTY_ARR) }],
    });

    assert(await ctx1.get(BlockService).waitForVerification(validBlock));
  }),
);
