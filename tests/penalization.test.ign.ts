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
  { name: `an invalid body should decrease the available account balance` },
  makeTest({}, async (testCtx, ctx) => {
    // const aHash = ctx.get(BlockService).create({
    //   inputs: [],
    //   outputs: [{
    //     verifier: {
    //       contract_hash: rootHash,
    //       params: Hash.digest('abc').toBytes(),
    //     },
    //     amount: 100n,
    //   }, {
    //     verifier: { contract_hash: trueHash, params: new Uint8Array([]) },
    //     amount: -100n,
    //   }],
    //   body: new Uint8Array([]),
    //   side: true,
    //   isFreeMarket: true,
    //   timestamp: 0n,
    // });
    // const a = ctx.get(BlockService).get(aHash)!;

    // const bColl = {
    //   collateral_input_idx: COLLATERAL_INPUT_IDX_INITIAL,
    //   valid: true,
    //   public_key: ctx.get(KeyService).getSelfPublicKey(),
    //   free_after: 0n + 10000n,
    // };
    // const bHash = ctx.get(BlockService).create({
    //   inputs: [{ block_hash: aHash, output_idx: 0 }],
    //   outputs: [{
    //     verifier: {
    //       contract_hash: collateralHash,
    //       params: CollateralContractParams.encode(bColl),
    //     },
    //     amount: 100n,
    //   }],
    //   body: str2bin('xyz'),
    //   side: true,
    //   isFreeMarket: true,
    //   timestamp: 0n,
    // });
    // const b = ctx.get(BlockService).get(bHash)!;

    // const c = await waitForBlock(ctx, { block_hash: bHash, output_idx: 0 });
    // const cColl = {
    //   collateral_input_idx: 0,
    //   valid: false,
    //   // public_key: ctx.get(KeyService).getSelfPublicKey(),
    //   free_after: 0n + 10000n,
    // };

    // assertObjectMatch(ctx.get(BlockService).getCollateral(b), {
    //   postedAmountFor: 100n,
    //   postedAmountAgainst: 110n,
    //   implicitAmountAgainst: 90n,
    //   ledger: [
    //     { block: b, params: bColl, amountDelta: 100n, outputIdx: 0 },
    //     { block: c, params: cColl, amountDelta: 110n, outputIdx: 0 },
    //   ],
    //   resolver: undefined,
    // });
  }),
);
