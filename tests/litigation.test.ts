import { makeTest, waitForBlock } from './util.ts';
import BlockService from '../sbl/BlockService.ts';
import Hash from '../sbl/util/Hash.ts';
import { collateralHash, rootHash, trueHash } from '../sbl/constants.ts';
import { str2bin } from '../sbl/pathUtils.ts';
import { assertEquals, assertObjectMatch } from 'std-latest/testing/asserts.ts';
import { CollateralContractParams } from '../sbl/messages.ts';
import NodeService from '../sbl/NodeService.ts';
import KeyService from '../sbl/KeyService.ts';
import { COLLATERAL_INPUT_IDX_INITIAL } from '../sbl/CollateralContract.ts';
import { mapOne } from '../sbl/util/functional.ts';

Deno.test(
  { name: `an invalid body should have collateral posted against` },
  makeTest({}, async (testCtx, ctx) => {
    const aHash = await ctx.get(BlockService).create({
      inputs: [],
      outputs: [{
        verifier: {
          contract_hash: rootHash,
          params: Hash.digest('abc').toBytes(),
        },
        amount: 10n,
      }, {
        verifier: { contract_hash: trueHash, params: new Uint8Array([]) },
        amount: -10n,
      }],
      body: new Uint8Array([]),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });
    const a = ctx.get(BlockService).get(aHash)!;

    const bColl = {
      collateral_input_idx: COLLATERAL_INPUT_IDX_INITIAL,
      valid: true,
      public_key: ctx.get(KeyService).getSelfPublicKey(),
      free_after: 0n + 10000n,
    };
    const bHash = await ctx.get(BlockService).create({
      inputs: [{ block_hash: aHash, output_idx: 0 }],
      outputs: [{
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode(bColl),
        },
        amount: 10n,
      }],
      body: str2bin('xyz'),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });
    const b = ctx.get(BlockService).get(bHash)!;

    const c = await waitForBlock(ctx, { block_hash: bHash, output_idx: 0 });
    const cColl = {
      collateral_input_idx: 0,
      valid: false,
      // public_key: ctx.get(KeyService).getSelfPublicKey(),
      free_after: 0n + 10000n,
    };

    assertObjectMatch(ctx.get(BlockService).getCollateral(b), {
      totalAmountFor: 10n,
      totalAmountAgainst: 20n,
      ledger: [
        { block: b, params: bColl, amountDelta: 10n, outputIdx: 0 },
        { block: c, params: cColl, amountDelta: 20n, outputIdx: 0 },
      ],
      resolver: undefined,
    });
  }),
);
