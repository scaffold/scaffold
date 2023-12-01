import { assert, assertFalse } from 'std-latest/assert/mod.ts';
import { makeTest, provideInitialBalance } from './util.ts';
import BlockBuilder from '~/sbl/BlockBuilder.ts';
import { accountHash } from '~/sbl/constants.ts';
import KeyService from '~/sbl/KeyService.ts';
import BlockService from '~/sbl/BlockService.ts';
import { AccountContractParams } from '~/sbl/messages.ts';

Deno.test(
  {
    name: `account contract test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [],
  }, async (_testCtx, ctx1, ctx2) => {
    provideInitialBalance(ctx1, ctx2);

    const validBlock = ctx1.get(BlockBuilder).publish({
      satisfies: [{
        contract_hash: accountHash,
        params: AccountContractParams.encode({
          public_key: ctx1.get(KeyService).getSelfPublicKey(),
        }),
      }],
    }, 0);

    const invalidBlock = ctx1.get(BlockBuilder).publish({
      satisfies: [{
        contract_hash: accountHash,
        params: AccountContractParams.encode({
          public_key: ctx2.get(KeyService).getSelfPublicKey(),
        }),
      }],
    }, 0);

    assert(await ctx1.get(BlockService).waitForVerification(validBlock));
    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);
