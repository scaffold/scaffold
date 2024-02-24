import { assert, assertEquals, assertFalse } from '$std/assert/mod.ts';
import { makeTest, provideInitialBalance } from '../util.ts';
import { BlockBuilder } from '../../src/BlockBuilder.ts';
import { rootHash } from '../../src/constants.ts';
import { KeyService } from '../../src/KeyService.ts';
import { BlockService } from '../../src/BlockService.ts';
import { AccountContractParams } from '../../src/messages.ts';
import { RootContract } from '../../src/contracts/RootContract.ts';
import { EMPTY_ARR, str2bin } from '../../src/util/buffer.ts';
import {
  baseContractProviders,
  waitForVerifiedOutput,
} from '../../tests/contracts/util.ts';
import { Hash } from '../../src/util/Hash.ts';

Deno.test(
  {
    name: `root contract generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new RootContract()],
  }, async (_testCtx, ctx1) => {
    const genesisHash = provideInitialBalance(ctx1);

    const incentiveBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      outputs: [{
        verifier: { contractHash: rootHash, params: genesisHash.toBytes() },
        amount: 10n,
        detail: EMPTY_ARR,
      }],
    });

    await waitForVerifiedOutput(ctx1, incentiveBlock, rootHash, true);
  }),
);

Deno.test(
  {
    name: `root contract validation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new RootContract()],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const validBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      body: str2bin('good'),
      satisfies: [{
        contractHash: rootHash,
        params: Hash.digest('good').toBytes(),
      }],
    });

    assert(await ctx1.get(BlockService).waitForVerification(validBlock));
  }),
);

Deno.test(
  {
    name: `root contract invalidation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new RootContract()],
  }, async (_testCtx, ctx1, ctx2) => {
    provideInitialBalance(ctx1, ctx2);

    const invalidBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      body: str2bin('bad'),
      satisfies: [{
        contractHash: rootHash,
        params: Hash.digest('good').toBytes(),
      }],
    });

    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);
