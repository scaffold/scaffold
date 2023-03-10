import Hash from '~/sbl/util/Hash.ts';
import { makeTest } from './util.ts';
import BlockService from '../sbl/BlockService.ts';
import { assertSnapshot } from 'std-latest/testing/snapshot.ts';

Deno.test(
  { name: `ingest should add block to our registry` },
  makeTest({}, async (testCtx, ctx) => {
    ctx.get(BlockService).ingest({
      inputs: [],
      outputs: [],
      body: new Uint8Array([]),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });

    await assertSnapshot(testCtx, ctx.get(BlockService).snapshot());
  }),
);
