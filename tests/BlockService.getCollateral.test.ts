import Hash from '~/sbl/util/Hash.ts';
import { makeTest } from './util.ts';
import BlockService from '../sbl/BlockService.ts';
import { assertSnapshot } from 'std-latest/testing/snapshot.ts';
import { collateralHash, trueHash } from '../sbl/constants.ts';
import { assertEquals, assertObjectMatch } from 'std-latest/testing/asserts.ts';
import { CollateralContractParams } from '../sbl/messages.ts';
import { COLLATERAL_INPUT_IDX_INITIAL } from '../sbl/CollateralContract.ts';
import KeyService from '../sbl/KeyService.ts';

Deno.test(
  { name: `getCollateral with no collateral` },
  makeTest({}, async (_testCtx, ctx) => {
    const aHash = await ctx.get(BlockService).create({
      inputs: [],
      outputs: [],
      body: new Uint8Array([]),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });
    const a = ctx.get(BlockService).get(aHash)!;

    assertObjectMatch(ctx.get(BlockService).getCollateral(a), {
      totalAmountFor: 0n,
      totalAmountAgainst: 0n,
      ledger: [],
      resolver: a,
    });
  }),
);

Deno.test(
  { name: `getCollateral with other collateral` },
  makeTest({}, async (_testCtx, ctx) => {
    const aColl = {
      collateral_input_idx: 0,
      valid: true,
      public_key: ctx.get(KeyService).getSelfPublicKey(),
      free_after: 0n + 10000n,
    };
    const aHash = await ctx.get(BlockService).create({
      inputs: [{ block_hash: Hash.random(), output_idx: 0 }],
      outputs: [{
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode(aColl),
        },
        amount: 10n,
      }],
      body: new Uint8Array([]),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });
    const a = ctx.get(BlockService).get(aHash)!;

    assertObjectMatch(ctx.get(BlockService).getCollateral(a), {
      totalAmountFor: 0n,
      totalAmountAgainst: 0n,
      ledger: [],
      resolver: a,
    });
  }),
);

Deno.test(
  { name: `getCollateral with one unresolved` },
  makeTest({}, async (_testCtx, ctx) => {
    const aColl = {
      collateral_input_idx: COLLATERAL_INPUT_IDX_INITIAL,
      valid: true,
      public_key: ctx.get(KeyService).getSelfPublicKey(),
      free_after: 0n + 10000n,
    };
    const aHash = await ctx.get(BlockService).create({
      inputs: [{ block_hash: Hash.random(), output_idx: 0 }],
      outputs: [{
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode(aColl),
        },
        amount: 10n,
      }],
      body: new Uint8Array([]),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });
    const a = ctx.get(BlockService).get(aHash)!;

    assertObjectMatch(ctx.get(BlockService).getCollateral(a), {
      totalAmountFor: 10n,
      totalAmountAgainst: 0n,
      ledger: [{ block: a, params: aColl, amountDelta: 10n, outputIdx: 0 }],
      resolver: undefined,
    });
  }),
);

Deno.test(
  { name: `getCollateral with two unresolved` },
  makeTest({}, async (_testCtx, ctx1, ctx2) => {
    const aColl = {
      collateral_input_idx: COLLATERAL_INPUT_IDX_INITIAL,
      valid: true,
      public_key: ctx1.get(KeyService).getSelfPublicKey(),
      free_after: 0n + 10000n,
    };
    const aHash = await ctx1.get(BlockService).create({
      inputs: [{ block_hash: Hash.random(), output_idx: 0 }],
      outputs: [{
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode(aColl),
        },
        amount: 10n,
      }],
      body: new Uint8Array([]),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });
    const a = ctx1.get(BlockService).get(aHash)!;

    const bColl = {
      collateral_input_idx: 1,
      valid: false,
      public_key: ctx2.get(KeyService).getSelfPublicKey(),
      free_after: 1000n + 10000n,
    };
    const bHash = await ctx1.get(BlockService).create({
      inputs: [
        { block_hash: Hash.random(), output_idx: 0 },
        { block_hash: aHash, output_idx: 0 },
      ],
      outputs: [{
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode(bColl),
        },
        amount: 40n,
      }],
      body: new Uint8Array([]),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });
    const b = ctx1.get(BlockService).get(bHash)!;

    assertObjectMatch(ctx1.get(BlockService).getCollateral(a), {
      totalAmountFor: 10n,
      totalAmountAgainst: 30n,
      ledger: [
        { block: a, params: aColl, amountDelta: 10n, outputIdx: 0 },
        { block: b, params: bColl, amountDelta: 30n, outputIdx: 0 },
      ],
      resolver: undefined,
    });

    assertObjectMatch(ctx1.get(BlockService).getCollateral(b), {
      totalAmountFor: 0n,
      totalAmountAgainst: 0n,
      ledger: [],
      resolver: b,
    });
  }),
);

Deno.test(
  { name: `getCollateral with one resolved correctly` },
  makeTest({}, async (_testCtx, ctx1, ctx2) => {
    const aColl = {
      collateral_input_idx: COLLATERAL_INPUT_IDX_INITIAL,
      valid: true,
      public_key: ctx1.get(KeyService).getSelfPublicKey(),
      free_after: 0n + 10000n,
    };
    const aHash = await ctx1.get(BlockService).create({
      inputs: [{ block_hash: Hash.random(), output_idx: 0 }],
      outputs: [{
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode(aColl),
        },
        amount: 10n,
      }],
      body: new Uint8Array([]),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });
    const a = ctx1.get(BlockService).get(aHash)!;

    const bHash = await ctx1.get(BlockService).create({
      inputs: [
        { block_hash: Hash.random(), output_idx: 0 },
        { block_hash: aHash, output_idx: 0 },
      ],
      outputs: [{
        verifier: { contract_hash: trueHash, params: new Uint8Array([]) },
        amount: 40n,
      }],
      body: new Uint8Array([]),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });
    const b = ctx1.get(BlockService).get(bHash)!;

    assertObjectMatch(ctx1.get(BlockService).getCollateral(a), {
      totalAmountFor: 10n,
      totalAmountAgainst: 0n,
      ledger: [{ block: a, params: aColl, amountDelta: 10n, outputIdx: 0 }],
      resolver: b,
    });

    assertObjectMatch(ctx1.get(BlockService).getCollateral(b), {
      totalAmountFor: 0n,
      totalAmountAgainst: 0n,
      ledger: [],
      resolver: b,
    });
  }),
);
