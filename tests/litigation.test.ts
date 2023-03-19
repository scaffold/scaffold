import { makeTest, waitForBlock } from './util.ts';
import BlockService from '../sbl/BlockService.ts';
import Hash from '../sbl/util/Hash.ts';
import { collateralHash, rootHash, trueHash } from '../sbl/constants.ts';
import { str2bin } from '../sbl/pathUtils.ts';
import { assertEquals, assertObjectMatch } from 'std-latest/testing/asserts.ts';
import {
  CollateralContractBody,
  CollateralContractParams,
} from '../sbl/messages.ts';
import NodeService from '../sbl/NodeService.ts';

Deno.test(
  { name: `an invalid body should have collateral posted against` },
  makeTest({}, async (testCtx, ctx) => {
    const a = ctx.get(BlockService).ingest({
      inputs: [],
      outputs: [{
        verifier: {
          contract_hash: rootHash,
          params: Hash.digest('abc').toBytes(),
        },
        amount: -10n,
      }, {
        verifier: { contract_hash: trueHash, params: new Uint8Array([]) },
        amount: 10n,
      }],
      body: new Uint8Array([]),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });

    const b = ctx.get(BlockService).ingest({
      inputs: [{ block_hash: a, output_idx: 0 }],
      outputs: [{
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode({
            public_key_hash: ctx.get(NodeService).getSelfHash(),
            free_after: 0n + 10000n,
            data_price: 1n,
          }),
        },
        amount: -10n,
      }],
      body: str2bin('xyz'),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });

    const c = await waitForBlock(ctx, { block_hash: b, output_idx: 0 });
    assertObjectMatch(c, {
      inputs: [{ block_hash: b, output_idx: 0 }],
      outputs: [],
    });
    assertEquals(CollateralContractBody.decode(c.body), {
      side: false,
      hint: new Uint8Array([]),
    });
  }),
);
