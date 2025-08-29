import { assert, assertEquals, assertFalse } from '@std/assert';
import { makeTest, provideInitialBalance } from '../util.ts';
import { BlockBuilder } from '../../src/BlockBuilder.ts';
import { collatzHash } from '../../src/hashes.ts';
import { BlockService } from '../../src/BlockService.ts';
import { CollatzContract } from '../../src/contracts/CollatzContract.ts';
import * as collatzMessages from '../../src/contracts/collatzMessages.ts';
import { EMPTY_ARR } from '../../src/util/buffer.ts';
import { encodeDataTree } from '../../src/DataTreeHelper.ts';
import { baseContractProviders, waitForVerifiedOutput } from '../../tests/contracts/util.ts';

const params: collatzMessages.Params = { num: 1n };
const goodAnswer: collatzMessages.Answer = { stoppingTime: 0n, maximum: 1n };
const badAnswer: collatzMessages.Answer = { stoppingTime: 0n, maximum: 123n };

// const params: collatzMessages.Params = { num: 2n };
// const goodAnswer: collatzMessages.Answer = { stoppingTime: 1n, maximum: 2n };
// const badAnswer: collatzMessages.Answer = { stoppingTime: 1n, maximum: 123n };

// const params: collatzMessages.Params = { num: 10n };
// const goodAnswer: collatzMessages.Answer = { stoppingTime: 6n, maximum: 16n };
// const badAnswer: collatzMessages.Answer = { stoppingTime: 10n, maximum: 123n };

Deno.test(
  {
    name: `collatz contract generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, CollatzContract],
    limitFactCount: 100,
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const incentiveBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      outputs: [{
        verifier: {
          contractHash: collatzHash,
          params: encodeDataTree(collatzMessages.Params.encode(params)),
        },
        amount: 10n,
        detail: encodeDataTree(EMPTY_ARR),
      }],
    });

    const consumer = await waitForVerifiedOutput(
      ctx1,
      incentiveBlock,
      collatzHash,
      true,
    );
    assertEquals(collatzMessages.Answer.decode(consumer!.body.value!.bytes), goodAnswer);
  }),
);

Deno.test(
  {
    name: `collatz contract validation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, CollatzContract],
    limitFactCount: 100,
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const validBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      body: encodeDataTree(collatzMessages.Answer.encode(goodAnswer)),
      satisfies: [{
        contractHash: collatzHash,
        params: encodeDataTree(collatzMessages.Params.encode(params)),
      }],
    });

    assert(await ctx1.get(BlockService).waitForVerification(validBlock));
  }),
);

Deno.test(
  {
    name: `collatz contract invalidation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, CollatzContract],
    limitFactCount: 100,
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const invalidBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      body: encodeDataTree(collatzMessages.Answer.encode(badAnswer)),
      satisfies: [{
        contractHash: collatzHash,
        params: encodeDataTree(collatzMessages.Params.encode(params)),
      }],
    });

    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);
