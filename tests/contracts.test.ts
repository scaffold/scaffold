import { assertEquals, assertNotEquals } from 'std-latest/testing/asserts.ts';
import { makeTest, provideInitialBalance } from './util.ts';
import BlockBuilder from '~/sbl/BlockBuilder.ts';
import { accountHash } from '~/sbl/constants.ts';
import KeyService from '~/sbl/KeyService.ts';
import BlockService from '~/sbl/BlockService.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import Context from '~/sbl/Context.ts';
import { AccountContractParams } from '~/sbl/messages.ts';

const assertVerification = async (
  ctx: Context,
  block: BlockFact,
  valid: boolean,
) => {
  await ctx.get(BlockService).waitForVerification(block);
  valid
    ? assertEquals(block.invalidatedInputs, 0n)
    : assertNotEquals(block.invalidatedInputs, 0n);
};

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

    await ctx1.get(BlockService).waitForVerification(validBlock);
    await ctx1.get(BlockService).waitForVerification(invalidBlock);

    assertEquals(validBlock.invalidatedInputs, 0n);
    assertNotEquals(invalidBlock.invalidatedInputs, 0n);
  }),
);
