import { assert, assertEquals, assertFalse } from '@std/assert';
import { makeTest, provideInitialBalance } from '../util.ts';
import { BlockBuilder } from '../../src/BlockBuilder.ts';
import { burnHash } from '../../src/hashes.ts';
import { BlockService } from '../../src/BlockService.ts';
import { BurnContract } from '../../src/contracts/BurnContract.ts';
import { EMPTY_ARR } from '../../src/util/buffer.ts';
import { baseContractProviders, waitForVerifiedOutput } from '../../tests/contracts/util.ts';

Deno.test(
  {
    name: `burn contract generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new BurnContract()],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const incentiveBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      outputs: [{
        verifier: { contractHash: burnHash, params: EMPTY_ARR },
        amount: 10n,
        detail: EMPTY_ARR,
      }],
    });

    await waitForVerifiedOutput(ctx1, incentiveBlock, burnHash, false);
  }),
);

Deno.test(
  {
    name: `burn contract invalidation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new BurnContract()],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const invalidBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      satisfies: [{ contractHash: burnHash, params: EMPTY_ARR }],
    });

    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);
