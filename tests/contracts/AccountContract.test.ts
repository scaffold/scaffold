import { assert, assertEquals, assertFalse } from '@std/assert';
import { makeTest, provideInitialBalance } from '../util.ts';
import { BlockBuilder } from '../../src/BlockBuilder.ts';
import { accountHash } from '../../src/hashes.ts';
import { KeyService } from '../../src/KeyService.ts';
import { BlockService } from '../../src/BlockService.ts';
import { AccountContractParams } from '../../src/messages.ts';
import { AccountContract } from '../../src/contracts/AccountContract.ts';
import { EMPTY_ARR } from '../../src/util/buffer.ts';
import { baseContractProviders, waitForVerifiedOutput } from '../../tests/contracts/util.ts';

Deno.test(
  {
    name: `account contract generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new AccountContract()],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const incentiveBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      outputs: [{
        verifier: {
          contractHash: accountHash,
          params: AccountContractParams.encode({
            publicKey: ctx1.get(KeyService).getSelfPublicKey(),
          }),
        },
        amount: 10n,
        detail: EMPTY_ARR,
      }],
    });

    await waitForVerifiedOutput(ctx1, incentiveBlock, accountHash, false);
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

    const validBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      satisfies: [{
        contractHash: accountHash,
        params: AccountContractParams.encode({
          publicKey: ctx1.get(KeyService).getSelfPublicKey(),
        }),
      }],
    });

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

    const invalidBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      satisfies: [{
        contractHash: accountHash,
        params: AccountContractParams.encode({
          publicKey: ctx2.get(KeyService).getSelfPublicKey(),
        }),
      }],
    });

    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);
