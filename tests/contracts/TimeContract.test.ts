import { assert, assertEquals, assertFalse } from 'std-latest/assert/mod.ts';
import { makeTest, provideInitialBalance } from '../util.ts';
import BlockBuilder from '../../src/BlockBuilder.ts';
import { timeHash } from '../../src/constants.ts';
import BlockService from '../../src/BlockService.ts';
import { TimeParams } from '../../src/messages.ts';
import TimeContract from '../../src/contracts/TimeContract.ts';
import { EMPTY_ARR } from '../../src/util/buffer.ts';
import {
  baseContractProviders,
  waitForVerifiedOutput,
} from '~/tests/contracts/util.ts';

Deno.test(
  {
    name: `time contract generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new TimeContract()],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const incentiveBlock = ctx1.get(BlockBuilder).publish({
      outputs: [{
        verifier: {
          contract_hash: timeHash,
          params: TimeParams.encode({ time: 123n }),
        },
        amount: 10n,
        detail: EMPTY_ARR,
      }],
    }, 0);

    await waitForVerifiedOutput(ctx1, incentiveBlock, timeHash, true);
  }),
);

Deno.test(
  {
    name: `time contract validation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new TimeContract()],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const validBlock = ctx1.get(BlockBuilder).publish({
      satisfies: [{
        contract_hash: timeHash,
        params: TimeParams.encode({ time: 0n }),
      }],
    }, 0);

    assert(await ctx1.get(BlockService).waitForVerification(validBlock));
  }),
);

Deno.test(
  {
    name: `time contract invalidation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new TimeContract()],
  }, async (_testCtx, ctx1, ctx2) => {
    provideInitialBalance(ctx1, ctx2);

    const invalidBlock = ctx1.get(BlockBuilder).publish({
      satisfies: [{
        contract_hash: timeHash,
        params: TimeParams.encode({ time: 123n }),
      }],
    }, 0);

    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);
