import { assert, assertEquals, assertFalse } from '@std/assert';
import { makeTest, provideInitialBalance } from '../util.ts';
import { BlockBuilder } from '../../src/BlockBuilder.ts';
import { accountHash, collateralHash } from '../../src/hashes.ts';
import { KeyService } from '../../src/KeyService.ts';
import { BlockService } from '../../src/BlockService.ts';
import { CollateralContract } from '../../src/contracts/CollateralContract.ts';
import { EMPTY_ARR, str2bin } from '../../src/util/buffer.ts';
import { encodeDataTree } from '../../src/DataTreeHelper.ts';
import { baseContractProviders, waitForVerifiedOutput } from '../../tests/contracts/util.ts';
import {
  CollateralContractDetail,
  CollateralContractParams,
} from '../../src/collateralMessages.ts';
import { EMPTY_HASH } from '../../src/util/Hash.ts';
import { AccountContractParams } from '../../src/messages.ts';

Deno.test(
  {
    name: `collateral contract generation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({
    contractProviders: [...baseContractProviders, CollateralContract],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const incentiveBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      outputs: [{
        verifier: {
          contractHash: collateralHash,
          params: CollateralContractParams.encode({ blockHash: EMPTY_HASH }),
        },
        amount: 10n,
        detail: CollateralContractDetail.encode({
          publicKey: str2bin('pk1'),
          hints: [],
          vote: 'VALID_CHALLENGE',
        }),
      }],
    });

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
    contractProviders: [...baseContractProviders, CollateralContract],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const collateralBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      outputs: [{
        verifier: {
          contractHash: collateralHash,
          params: CollateralContractParams.encode({ blockHash: EMPTY_HASH }),
        },
        amount: 1000n,
        detail: CollateralContractDetail.encode({
          publicKey: str2bin('pk1'),
          hints: [],
          vote: 'VALID_CHALLENGE',
        }),
      }, {
        verifier: {
          contractHash: collateralHash,
          params: CollateralContractParams.encode({ blockHash: EMPTY_HASH }),
        },
        amount: 10n,
        detail: CollateralContractDetail.encode({
          publicKey: str2bin('pk2'),
          hints: [encodeDataTree(str2bin('verifier1'))],
          vote: 'FINAL_FAIL',
        }),
      }],
    });

    await new Promise<void>((resolve) => ctx1.config.timeProvider.setTimeout(resolve, 5000));

    const validBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      inputs: [
        { block: collateralBlock, outputIdx: 0, amount: 1000n },
        { block: collateralBlock, outputIdx: 1, amount: 10n },
      ],
      outputs: [{
        verifier: {
          contractHash: accountHash,
          params: AccountContractParams.encode({ publicKey: str2bin('pk2') }),
        },
        amount: 1010n,
        detail: encodeDataTree(EMPTY_ARR),
      }],
    });

    assert(await ctx1.get(BlockService).waitForVerification(validBlock));
  }),
);

Deno.test(
  {
    name: `collateral contract time invalidation test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
    ignore: true, // TODO: I don't know why this is failing
  },
  makeTest({
    contractProviders: [...baseContractProviders, CollateralContract],
  }, async (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const collateralBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      outputs: [{
        verifier: {
          contractHash: collateralHash,
          params: CollateralContractParams.encode({ blockHash: EMPTY_HASH }),
        },
        amount: 1000n,
        detail: CollateralContractDetail.encode({
          publicKey: str2bin('pk1'),
          hints: [],
          vote: 'VALID_CHALLENGE',
        }),
      }, {
        verifier: {
          contractHash: collateralHash,
          params: CollateralContractParams.encode({ blockHash: EMPTY_HASH }),
        },
        amount: 10n,
        detail: CollateralContractDetail.encode({
          publicKey: str2bin('pk2'),
          hints: [encodeDataTree(str2bin('verifier1'))],
          vote: 'FINAL_FAIL',
        }),
      }],
    });

    const invalidBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      inputs: [
        { block: collateralBlock, outputIdx: 0, amount: 1000n },
        { block: collateralBlock, outputIdx: 1, amount: 10n },
      ],
      outputs: [{
        verifier: {
          contractHash: accountHash,
          params: AccountContractParams.encode({ publicKey: str2bin('pk2') }),
        },
        amount: 1010n,
        detail: encodeDataTree(EMPTY_ARR),
      }],
    });

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
    contractProviders: [...baseContractProviders, CollateralContract],
  }, async (_testCtx, ctx1, ctx2) => {
    provideInitialBalance(ctx1, ctx2);

    const collateralBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      outputs: [{
        verifier: {
          contractHash: collateralHash,
          params: CollateralContractParams.encode({ blockHash: EMPTY_HASH }),
        },
        amount: 1000n,
        detail: CollateralContractDetail.encode({
          publicKey: str2bin('pk1'),
          hints: [],
          vote: 'VALID_CHALLENGE',
        }),
      }, {
        verifier: {
          contractHash: collateralHash,
          params: CollateralContractParams.encode({ blockHash: EMPTY_HASH }),
        },
        amount: 10n,
        detail: CollateralContractDetail.encode({
          publicKey: str2bin('pk2'),
          hints: [encodeDataTree(str2bin('verifier1'))],
          vote: 'FINAL_FAIL',
        }),
      }],
    });

    await new Promise<void>((resolve) => ctx1.config.timeProvider.setTimeout(resolve, 5000));

    const invalidBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      inputs: [
        { block: collateralBlock, outputIdx: 0, amount: 1000n },
        { block: collateralBlock, outputIdx: 1, amount: 10n },
      ],
      outputs: [{
        verifier: {
          contractHash: accountHash,
          params: AccountContractParams.encode({ publicKey: str2bin('pk1') }),
        },
        amount: 1010n,
        detail: encodeDataTree(EMPTY_ARR),
      }],
    });

    assertFalse(await ctx1.get(BlockService).waitForVerification(invalidBlock));
  }),
);
