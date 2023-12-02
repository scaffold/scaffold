import { assert, assertEquals, assertFalse } from 'std-latest/assert/mod.ts';
import { makeTest, provideInitialBalance } from '../util.ts';
import BlockBuilder from '~/sbl/BlockBuilder.ts';
import { accountHash } from '~/sbl/constants.ts';
import KeyService from '~/sbl/KeyService.ts';
import BlockService from '~/sbl/BlockService.ts';
import { AccountContractParams } from '~/sbl/messages.ts';
import AccountContract from '~/sbl/contracts/AccountContract.ts';
import { EMPTY_ARR } from '~/sbl/util/buffer.ts';
import { baseContractProviders } from '~/tests/contracts/util.ts';

Deno.test(
  {
    name: `account contract generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
    ignore: true, // Ignoring because account contract generation is disabled
  },
  makeTest({
    contractProviders: [...baseContractProviders, new AccountContract()],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const incentiveBlock = ctx1.get(BlockBuilder).publish({
      outputs: [{
        verifier: {
          contract_hash: accountHash,
          params: AccountContractParams.encode({
            public_key: ctx1.get(KeyService).getSelfPublicKey(),
          }),
        },
        amount: 10n,
        detail: EMPTY_ARR,
      }],
    }, 0);

    assertEquals(incentiveBlock.outputs[0].verifier.contract_hash, accountHash);
    const consumer = await ctx1.get(BlockService)
      .waitForConsumption({ block_hash: incentiveBlock.hash, output_idx: 0 });
    assert(await ctx1.get(BlockService).waitForVerification(consumer));
  }),
);

Deno.test(
  {
    name: `account contract validation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new AccountContract()],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const validBlock = ctx1.get(BlockBuilder).publish({
      satisfies: [{
        contract_hash: accountHash,
        params: AccountContractParams.encode({
          public_key: ctx1.get(KeyService).getSelfPublicKey(),
        }),
      }],
    }, 0);

    assert(await ctx1.get(BlockService).waitForVerification(validBlock));
  }),
);

Deno.test(
  {
    name: `account contract invalidation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new AccountContract()],
  }, async (_testCtx, ctx1, ctx2) => {
    provideInitialBalance(ctx1, ctx2);

    const invalidBlock = ctx1.get(BlockBuilder).publish({
      satisfies: [{
        contract_hash: accountHash,
        params: AccountContractParams.encode({
          public_key: ctx2.get(KeyService).getSelfPublicKey(),
        }),
      }],
    }, 0);

    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);
