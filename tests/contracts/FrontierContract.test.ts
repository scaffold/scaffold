import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertStrictEquals,
} from 'std-latest/assert/mod.ts';
import { makeTest, provideInitialBalance } from '../util.ts';
import BlockBuilder from '~/sbl/BlockBuilder.ts';
import { frontierHash } from '~/sbl/constants.ts';
import BlockService from '~/sbl/BlockService.ts';
import FrontierContract from '~/sbl/contracts/FrontierContract.ts';
import { EMPTY_ARR } from '~/sbl/util/buffer.ts';
import {
  baseContractProviders,
  waitForVerifiedOutput,
} from '~/tests/contracts/util.ts';
import { FrontierTreeParams } from '~/sbl/messages.ts';
import FactService from '~/sbl/FactService.ts';

Deno.test(
  {
    name: `frontier contract no generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new FrontierContract()],
    allowSpecifiedFrontierOutputs: true,
  }, async (_testCtx, ctx1) => {
    const genesisHash = provideInitialBalance(ctx1);
    const genesisBlock = ctx1.get(BlockService).get(genesisHash)!;

    await waitForVerifiedOutput(ctx1, genesisBlock, frontierHash, false);
    assertEquals(ctx1.get(FactService).getSize(), 1);
  }),
);

Deno.test(
  {
    name: `frontier contract generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new FrontierContract()],
    allowSpecifiedFrontierOutputs: true,
  }, async (_testCtx, ctx1) => {
    const genesisHash = provideInitialBalance(ctx1);
    const genesisBlock = ctx1.get(BlockService).get(genesisHash)!;

    const incentiveBlock = ctx1.get(BlockBuilder).publish({
      outputs: [{
        verifier: {
          contract_hash: frontierHash,
          params: FrontierTreeParams.encode({ level: 0 }),
        },
        amount: 10n,
        detail: EMPTY_ARR,
      }],
    }, 0);

    const consumer1 = await waitForVerifiedOutput(
      ctx1,
      genesisBlock,
      frontierHash,
      true,
    );
    const consumer2 = await waitForVerifiedOutput(
      ctx1,
      incentiveBlock,
      frontierHash,
      true,
    );
    assertStrictEquals(consumer1, consumer2);
    assertEquals(ctx1.get(FactService).getSize(), 3);
  }),
);

Deno.test(
  {
    name: `frontier contract 3-block generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new FrontierContract()],
    allowSpecifiedFrontierOutputs: true,
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    ctx1.get(BlockBuilder).publish({
      outputs: [{
        verifier: {
          contract_hash: frontierHash,
          params: FrontierTreeParams.encode({ level: 0 }),
        },
        amount: 10n,
        detail: EMPTY_ARR,
      }],
    }, 0);

    const incentiveBlock = ctx1.get(BlockBuilder).publish({
      outputs: [{
        verifier: {
          contract_hash: frontierHash,
          params: FrontierTreeParams.encode({ level: 0 }),
        },
        amount: 10n,
        detail: EMPTY_ARR,
      }],
    }, 0);

    await waitForVerifiedOutput(ctx1, incentiveBlock, frontierHash, false);
    assertEquals(ctx1.get(FactService).getSize(), 4);
  }),
);

Deno.test(
  {
    name: `frontier contract validation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new FrontierContract()],
    allowSpecifiedFrontierOutputs: true,
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const validBlock = ctx1.get(BlockBuilder).publish({
      frontierLevel: 4,
      satisfies: [{
        contract_hash: frontierHash,
        params: FrontierTreeParams.encode({ level: 3 }),
      }, {
        contract_hash: frontierHash,
        params: FrontierTreeParams.encode({ level: 3 }),
      }],
    }, 0);

    assert(await ctx1.get(BlockService).waitForVerification(validBlock));
  }),
);

Deno.test(
  {
    name: `frontier contract invalidation by input count test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new FrontierContract()],
    allowSpecifiedFrontierOutputs: true,
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const invalidBlock = ctx1.get(BlockBuilder).publish({
      frontierLevel: 4,
      satisfies: [{
        contract_hash: frontierHash,
        params: FrontierTreeParams.encode({ level: 3 }),
      }],
    }, 0);

    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);

Deno.test(
  {
    name: `frontier contract invalidation by level test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new FrontierContract()],
    allowSpecifiedFrontierOutputs: true,
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const invalidBlock = ctx1.get(BlockBuilder).publish({
      frontierLevel: 5,
      satisfies: [{
        contract_hash: frontierHash,
        params: FrontierTreeParams.encode({ level: 3 }),
      }, {
        contract_hash: frontierHash,
        params: FrontierTreeParams.encode({ level: 3 }),
      }],
    }, 0);

    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);
