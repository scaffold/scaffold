import { assert, assertEquals, assertFalse } from 'std-latest/assert/mod.ts';
import { makeTest, provideInitialBalance } from '../util.ts';
import BlockBuilder from '~/sbl/BlockBuilder.ts';
import { dataHash } from '~/sbl/constants.ts';
import BlockService from '~/sbl/BlockService.ts';
import DataContract from '~/sbl/contracts/DataContract.ts';
import { EMPTY_ARR } from '~/sbl/util/buffer.ts';
import { baseContractProviders } from '~/tests/contracts/util.ts';
import { DataContractParams } from '~/sbl/messages.ts';

Deno.test(
  {
    name: `data contract generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new DataContract()],
    limitFactCount: 100,
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const incentiveBlock = ctx1.get(BlockBuilder).publish({
      outputs: [{
        verifier: {
          contract_hash: dataHash,
          params: DataContractParams.encode(params),
        },
        amount: 10n,
        detail: EMPTY_ARR,
      }],
    }, 0);

    assertEquals(incentiveBlock.outputs[0].verifier.contract_hash, dataHash);
    const consumer = await ctx1.get(BlockService)
      .waitForConsumption({ block_hash: incentiveBlock.hash, output_idx: 0 });
    assert(await ctx1.get(BlockService).waitForVerification(consumer));
    assertEquals(collatzMessages.Answer.decode(consumer.body), goodAnswer);
  }),
);

Deno.test(
  {
    name: `data contract validation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new DataContract()],
    limitFactCount: 100,
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const validBlock = ctx1.get(BlockBuilder).publish({
      body: collatzMessages.Answer.encode(goodAnswer),
      satisfies: [{
        contract_hash: dataHash,
        params: DataContractParams.encode(params),
      }],
    }, 0);

    assert(await ctx1.get(BlockService).waitForVerification(validBlock));
  }),
);

Deno.test(
  {
    name: `data contract invalidation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new DataContract()],
    limitFactCount: 100,
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const invalidBlock = ctx1.get(BlockBuilder).publish({
      body: collatzMessages.Answer.encode(badAnswer),
      satisfies: [{
        contract_hash: dataHash,
        params: DataContractParams.encode(params),
      }],
    }, 0);

    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);
