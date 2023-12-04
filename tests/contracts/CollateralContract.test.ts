import { assert, assertEquals, assertFalse } from 'std-latest/assert/mod.ts';
import { makeTest, provideInitialBalance } from '../util.ts';
import BlockBuilder from '~/sbl/BlockBuilder.ts';
import { accountHash, collateralHash } from '~/sbl/constants.ts';
import KeyService from '~/sbl/KeyService.ts';
import BlockService from '~/sbl/BlockService.ts';
import CollateralContract from '~/sbl/contracts/CollateralContract.ts';
import { EMPTY_ARR, str2bin } from '~/sbl/util/buffer.ts';
import {
  baseContractProviders,
  waitForVerifiedOutput,
} from '~/tests/contracts/util.ts';
import {
  CollateralContractDetail,
  CollateralContractParams,
} from '~/sbl/collateralMessages.ts';
import { EMPTY_HASH } from '~/sbl/util/Hash.ts';
import { AccountContractParams } from '~/sbl/messages.ts';

Deno.test(
  {
    name: `collateral contract generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new CollateralContract()],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const incentiveBlock = ctx1.get(BlockBuilder).publish({
      outputs: [{
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode({ block_hash: EMPTY_HASH }),
        },
        amount: 10n,
        detail: CollateralContractDetail.encode({
          public_key: str2bin('pk1'),
          hints: [],
          vote: 'VALID_CHALLENGE',
        }),
      }],
    }, 0);

    await waitForVerifiedOutput(ctx1, incentiveBlock, collateralHash, true);
  }),
);

Deno.test(
  {
    name: `collateral contract validation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new CollateralContract()],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const collateralBlock = ctx1.get(BlockBuilder).publish({
      outputs: [{
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode({ block_hash: EMPTY_HASH }),
        },
        amount: 1000n,
        detail: CollateralContractDetail.encode({
          public_key: str2bin('pk1'),
          hints: [],
          vote: 'VALID_CHALLENGE',
        }),
      }, {
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode({ block_hash: EMPTY_HASH }),
        },
        amount: 10n,
        detail: CollateralContractDetail.encode({
          public_key: str2bin('pk2'),
          hints: [str2bin('verifier1')],
          vote: 'FINAL_FAIL',
        }),
      }],
    }, 0);

    await new Promise<void>((resolve) =>
      ctx1.config.timeProvider.setTimeout(resolve, 5000)
    );

    const validBlock = ctx1.get(BlockBuilder).publish({
      inputs: [
        { block: collateralBlock, outputIdx: 0, amount: 1000n },
        { block: collateralBlock, outputIdx: 1, amount: 10n },
      ],
      outputs: [{
        verifier: {
          contract_hash: accountHash,
          params: AccountContractParams.encode({ public_key: str2bin('pk2') }),
        },
        amount: 1010n,
        detail: EMPTY_ARR,
      }],
    }, 0);

    assert(await ctx1.get(BlockService).waitForVerification(validBlock));
  }),
);

Deno.test(
  {
    name: `collateral contract time invalidation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new CollateralContract()],
  }, async (_testCtx, ctx1, ctx2) => {
    provideInitialBalance(ctx1, ctx2);

    const collateralBlock = ctx1.get(BlockBuilder).publish({
      outputs: [{
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode({ block_hash: EMPTY_HASH }),
        },
        amount: 1000n,
        detail: CollateralContractDetail.encode({
          public_key: str2bin('pk1'),
          hints: [],
          vote: 'VALID_CHALLENGE',
        }),
      }, {
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode({ block_hash: EMPTY_HASH }),
        },
        amount: 10n,
        detail: CollateralContractDetail.encode({
          public_key: str2bin('pk2'),
          hints: [str2bin('verifier1')],
          vote: 'FINAL_FAIL',
        }),
      }],
    }, 0);

    const invalidBlock = ctx1.get(BlockBuilder).publish({
      inputs: [
        { block: collateralBlock, outputIdx: 0, amount: 1000n },
        { block: collateralBlock, outputIdx: 1, amount: 10n },
      ],
      outputs: [{
        verifier: {
          contract_hash: accountHash,
          params: AccountContractParams.encode({ public_key: str2bin('pk2') }),
        },
        amount: 1010n,
        detail: EMPTY_ARR,
      }],
    }, 0);

    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);

Deno.test(
  {
    name: `collateral contract output invalidation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, new CollateralContract()],
  }, async (_testCtx, ctx1, ctx2) => {
    provideInitialBalance(ctx1, ctx2);

    const collateralBlock = ctx1.get(BlockBuilder).publish({
      outputs: [{
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode({ block_hash: EMPTY_HASH }),
        },
        amount: 1000n,
        detail: CollateralContractDetail.encode({
          public_key: str2bin('pk1'),
          hints: [],
          vote: 'VALID_CHALLENGE',
        }),
      }, {
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode({ block_hash: EMPTY_HASH }),
        },
        amount: 10n,
        detail: CollateralContractDetail.encode({
          public_key: str2bin('pk2'),
          hints: [str2bin('verifier1')],
          vote: 'FINAL_FAIL',
        }),
      }],
    }, 0);

    await new Promise<void>((resolve) =>
      ctx1.config.timeProvider.setTimeout(resolve, 5000)
    );

    const invalidBlock = ctx1.get(BlockBuilder).publish({
      inputs: [
        { block: collateralBlock, outputIdx: 0, amount: 1000n },
        { block: collateralBlock, outputIdx: 1, amount: 10n },
      ],
      outputs: [{
        verifier: {
          contract_hash: accountHash,
          params: AccountContractParams.encode({ public_key: str2bin('pk1') }),
        },
        amount: 1010n,
        detail: EMPTY_ARR,
      }],
    }, 0);

    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);
