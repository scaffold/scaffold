import { makeTest, waitForBlock } from './util.ts';
import BlockService from '../sbl/BlockService.ts';
import Hash from '../sbl/util/Hash.ts';
import { collateralHash, rootHash, trueHash } from '../sbl/constants.ts';
import { str2bin } from '../sbl/pathUtils.ts';
import { assertEquals } from 'std-latest/testing/asserts.ts';
import { CollateralContractBody } from '../sbl/messages.ts';

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
        verifier: { contract_hash: collateralHash, params: new Uint8Array([]) },
        amount: -10n,
      }],
      body: str2bin('xyz'),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });

    const c = await waitForBlock(ctx, { block_hash: b, output_idx: 0 });
    assertEquals(c.inputs.length, 1);
    assertEquals(c.outputs.length, 1);
    assertEquals(
      c.body,
      CollateralContractBody.encode({ side: true, hint: new Uint8Array([]) }),
    );
  }),
);
