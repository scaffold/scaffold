import { assert, assertEquals, assertFalse } from 'std-latest/assert/mod.ts';
import { makeTest, provideInitialBalance } from '../util.ts';
import BlockBuilder from '~/sbl/BlockBuilder.ts';
import { collatzHash } from '~/sbl/constants.ts';
import BlockService from '~/sbl/BlockService.ts';
import CollatzContract from '~/sbl/contracts/CollatzContract.ts';
import { EMPTY_ARR } from '~/sbl/util/buffer.ts';
import { baseContractProviders } from '~/tests/contracts/util.ts';
import * as collatzMessages from '~/sbl/contracts/collatzMessages.ts';

const params: collatzMessages.Params = { num: 1n };
const goodAnswer: collatzMessages.Answer = { stopping_time: 0n, maximum: 1n };
const badAnswer: collatzMessages.Answer = { stopping_time: 0n, maximum: 123n };

// const params: collatzMessages.Params = { num: 2n };
// const goodAnswer: collatzMessages.Answer = { stopping_time: 1n, maximum: 2n };
// const badAnswer: collatzMessages.Answer = { stopping_time: 1n, maximum: 123n };

// const params: collatzMessages.Params = { num: 10n };
// const goodAnswer: collatzMessages.Answer = { stopping_time: 6n, maximum: 16n };
// const badAnswer: collatzMessages.Answer = { stopping_time: 10n, maximum: 123n };

Deno.test(
  {
    name: `collatz contract generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new CollatzContract()],
    limitFactCount: 100,
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const incentiveBlock = ctx1.get(BlockBuilder).publish({
      outputs: [{
        verifier: {
          contract_hash: collatzHash,
          params: collatzMessages.Params.encode(params),
        },
        amount: 10n,
        detail: EMPTY_ARR,
      }],
    }, 0);

    assertEquals(incentiveBlock.outputs[0].verifier.contract_hash, collatzHash);
    const consumer = await ctx1.get(BlockService)
      .waitForConsumption({ block_hash: incentiveBlock.hash, output_idx: 0 });
    assert(await ctx1.get(BlockService).waitForVerification(consumer));
    assertEquals(collatzMessages.Answer.decode(consumer.body), goodAnswer);
  }),
);

Deno.test(
  {
    name: `collatz contract validation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new CollatzContract()],
    limitFactCount: 100,
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const validBlock = ctx1.get(BlockBuilder).publish({
      body: collatzMessages.Answer.encode(goodAnswer),
      satisfies: [{
        contract_hash: collatzHash,
        params: collatzMessages.Params.encode(params),
      }],
    }, 0);

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
    contractProviders: [...baseContractProviders, new CollatzContract()],
    limitFactCount: 100,
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const invalidBlock = ctx1.get(BlockBuilder).publish({
      body: collatzMessages.Answer.encode(badAnswer),
      satisfies: [{
        contract_hash: collatzHash,
        params: collatzMessages.Params.encode(params),
      }],
    }, 0);

    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);
