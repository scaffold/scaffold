import { makeTest } from './util.ts';
import BlockService from '../src/BlockService.ts';
import Hash from '../src/util/Hash.ts';
import { str2bin } from '../sbl/pathUtils.ts';
import { assertEquals } from 'std-latest/testing/asserts.ts';
import HashInversionService from '../sbl/HashInversionService.ts';

Deno.test(
  { name: `hash inversion works for provided data` },
  makeTest({}, (_testCtx, ctx) => {
    ctx.get(HashInversionService).provide(str2bin('abc'));

    assertEquals(
      ctx.get(HashInversionService).invert(Hash.digest('abc')),
      str2bin('abc'),
    );
  }),
);

Deno.test(
  { name: `hash inversion works for blocks` },
  makeTest({}, (_testCtx, ctx) => {
    const aHash = ctx.get(BlockService).create({
      inputs: [],
      outputs: [],
      body: str2bin('abc'),
      side: true,
      isFreeMarket: true,
      timestamp: 0n,
    });
    const a = ctx.get(BlockService).get(aHash)!;

    assertEquals(ctx.get(HashInversionService).invert(aHash), a.data);
  }),
);
