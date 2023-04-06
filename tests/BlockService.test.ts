import Hash from '~/sbl/util/Hash.ts';
import { makeTest } from './util.ts';
import BlockService from '../sbl/BlockService.ts';
import { assertSnapshot } from 'std-latest/testing/snapshot.ts';
import { trueHash } from '../sbl/constants.ts';
import { assertEquals } from 'https://deno.land/std@0.153.0/testing/asserts.ts';

Deno.test(
  { name: `ingest should add block to our registry` },
  makeTest({}, async (testCtx, ctx) => {
    ctx.get(BlockService).create({
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

Deno.test(
  { name: `ingesting a parent should update verifiers` },
  makeTest({}, async (_testCtx, ctx1, ctx2) => {
    const verifier = { contract_hash: trueHash, params: new Uint8Array([123]) };

    const a = await ctx1.get(BlockService).create({
      inputs: [],
      outputs: [{ verifier, amount: 1n }],
      body: new Uint8Array([]),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });
    const aData = ctx1.get(BlockService).get(a)!.data;

    const b = await ctx2.get(BlockService).create({
      inputs: [{ block_hash: a, output_idx: 0 }],
      outputs: [],
      body: new Uint8Array([]),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });

    assertEquals(ctx2.get(BlockService).get(b)!.verifiers, []);
    ctx2.get(BlockService).ingest(aData);
    assertEquals(ctx2.get(BlockService).get(b)!.verifiers, [verifier]);
  }),
);
