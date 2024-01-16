import { assert, assertEquals } from 'std-latest/assert/mod.ts';
import { makeTest, provideInitialBalance } from '../util.ts';
import BlockBuilder from '../../src/BlockBuilder.ts';
import { trueHash } from '../../src/constants.ts';
import BlockService from '../../src/BlockService.ts';
import TrueContract from '../../src/contracts/TrueContract.ts';
import { EMPTY_ARR } from '../../src/util/buffer.ts';
import {
  baseContractProviders,
  waitForVerifiedOutput,
} from '~/tests/contracts/util.ts';

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

    await waitForVerifiedOutput(ctx1, incentiveBlock, trueHash, true);
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
