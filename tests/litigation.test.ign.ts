import { connectCtxs, makeTest, waitFor } from './util.ts';
import BlockService from '../src/BlockService.ts';
import Hash from '../src/util/Hash.ts';
import {
  accountHash,
  collateralHash,
  rootHash,
  trueHash,
} from '../src/constants.ts';
import { str2bin } from '../sbl/pathUtils.ts';
import { assertEquals, assertObjectMatch } from 'std-latest/testing/asserts.ts';
import {
  AccountContractParams,
  CollateralContractParams,
} from '../src/messages.ts';
import NodeService from '../src/NodeService.ts';
import KeyService from '../src/KeyService.ts';
import { COLLATERAL_INPUT_IDX_INITIAL } from '../sbl/CollateralContract.ts';
import { mapOne } from '../src/util/functional.ts';
import LitigationService from '../src/LitigationService.ts';

Deno.test(
  { name: `an invalid body should have collateral posted against` },
  makeTest({}, async (testCtx, ctx1, ctx2) => {
    connectCtxs([ctx1, ctx2], 'mesh');
    await new Promise<void>((resolve) =>
      ctx2.config.timeProvider.setTimeout(resolve, 100)
    );

    const incentiveBlock = ctx1.get(BlockService).create({
      inputs: [{ block_hash: Hash.random(), output_idx: 123 }],
      outputs: [{
        verifier: {
          contractHash: rootHash,
          params: Hash.digest('abc').toBytes(),
        },
        amount: 100n,
      }],
      body: new Uint8Array([]),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });

    const claimBlock = ctx2.get(BlockService).create({
      inputs: [{ block_hash: incentiveBlock.hash, output_idx: 0 }],
      outputs: [{
        verifier: {
          contractHash: accountHash,
          params: AccountContractParams.encode({
            public_key: ctx2.get(KeyService).getSelfPublicKey(),
          }),
        },
        amount: 100n,
      }],
      body: str2bin('xyz'),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });

    ctx2.get(LitigationService).litigateBlock(claimBlock, true);

    console.log(ctx2.get(BlockService).getCollateral(claimBlock));

    await waitFor(ctx1, (ctx) => {
      return ctx.get(BlockService).getCollateral(claimBlock).ledger.length ||
        undefined;
    });

    // const c = await waitForBlock(ctx1, { block_hash: claimBlock.hash, output_idx: 0 });
    // const dColl = {
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
    //     { block: c, params: dColl, amountDelta: 110n, outputIdx: 0 },
    //   ],
    //   resolver: undefined,
    // });
  }),
);
