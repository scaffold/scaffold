import { makeTest } from './util.ts';
import BlockService from '../sbl/BlockService.ts';
import { assertEquals, assertObjectMatch } from 'std-latest/testing/asserts.ts';
import KeyService from '../sbl/KeyService.ts';
import { collateralHash } from '../sbl/constants.ts';
import { CollateralContractParams } from '../sbl/messages.ts';
import Hash from '../sbl/util/Hash.ts';

Deno.test(
  { name: `collateral should not be included in work` },
  makeTest({}, (_testCtx, ctx) => {
    const aColl = {
      collateral_input_idx: 0,
      valid: true,
      public_key: ctx.get(KeyService).getSelfPublicKey(),
      free_after: 0n + 10000n,
    };
    const aHash = ctx.get(BlockService).create({
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

    assertEquals(ctx.get(BlockService).getWork(a), 11n);
  }),
);
