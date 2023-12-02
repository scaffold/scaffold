import { assert, assertEquals, assertFalse } from 'std-latest/assert/mod.ts';
import { makeTest, provideInitialBalance } from '../util.ts';
import BlockBuilder from '~/sbl/BlockBuilder.ts';
import { burnHash } from '~/sbl/constants.ts';
import BlockService from '~/sbl/BlockService.ts';
import BurnContract from '~/sbl/contracts/BurnContract.ts';
import { EMPTY_ARR } from '~/sbl/util/buffer.ts';
import { baseContractProviders } from '~/tests/contracts/util.ts';

Deno.test(
  {
    name: `burn contract generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
    ignore: true, // Ignoring because burned outputs cannot be consumed; ideally we will want to assert this is the case
  },
  makeTest({
    contractProviders: [...baseContractProviders, new BurnContract()],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const incentiveBlock = ctx1.get(BlockBuilder).publish({
      outputs: [{
        verifier: { contract_hash: burnHash, params: EMPTY_ARR },
        amount: 10n,
        detail: EMPTY_ARR,
      }],
    }, 0);

    assertEquals(incentiveBlock.outputs[0].verifier.contract_hash, burnHash);
    const consumer = await ctx1.get(BlockService)
      .waitForConsumption({ block_hash: incentiveBlock.hash, output_idx: 0 });
    assert(await ctx1.get(BlockService).waitForVerification(consumer));
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

    const invalidBlock = ctx1.get(BlockBuilder).publish({
      satisfies: [{ contract_hash: burnHash, params: EMPTY_ARR }],
    }, 0);

    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);
