import { assert, assertEquals } from 'std-latest/assert/mod.ts';
import { makeTest, provideInitialBalance } from '../util.ts';
import BlockBuilder from '~/sbl/BlockBuilder.ts';
import { trueHash } from '~/sbl/constants.ts';
import BlockService from '~/sbl/BlockService.ts';
import TrueContract from '~/sbl/contracts/TrueContract.ts';
import { EMPTY_ARR } from '~/sbl/util/buffer.ts';
import { baseContractProviders } from '~/tests/contracts/util.ts';

Deno.test(
  {
    name: `true contract generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new TrueContract()],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const incentiveBlock = ctx1.get(BlockBuilder).publish({
      outputs: [{
        verifier: { contract_hash: trueHash, params: EMPTY_ARR },
        amount: 10n,
        detail: EMPTY_ARR,
      }],
    }, 0);

    assertEquals(incentiveBlock.outputs[0].verifier.contract_hash, trueHash);
    const consumer = await ctx1.get(BlockService)
      .waitForConsumption({ block_hash: incentiveBlock.hash, output_idx: 0 });
    assert(await ctx1.get(BlockService).waitForVerification(consumer));
  }),
);

Deno.test(
  {
    name: `true contract validation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new TrueContract()],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const validBlock = ctx1.get(BlockBuilder).publish({
      satisfies: [{ contract_hash: trueHash, params: EMPTY_ARR }],
    }, 0);

    assert(await ctx1.get(BlockService).waitForVerification(validBlock));
  }),
);
