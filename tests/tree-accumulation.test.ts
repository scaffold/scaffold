import { makeTest, provideInitialBalance } from './util.ts';
import BlockBuilder from '~/sbl/BlockBuilder.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import { frontierHash } from '~/sbl/constants.ts';
import { assertNotEquals } from 'std-latest/assert/assert_not_equals.ts';
import Hash from '~/sbl/util/Hash.ts';
import { assertEquals } from 'std-latest/assert/assert_equals.ts';
import BlockService from '~/sbl/BlockService.ts';
import FactService from '~/sbl/FactService.ts';

Deno.test(
  {
    name: `tree accumulation triggers`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  makeTest({}, async (_testCtx, ctx) => {
    const aHash = provideInitialBalance(ctx);

    const findFrontierIdx = (block: BlockFact) =>
      block.outputs.findIndex((output) =>
        Hash.equals(output.verifier.contract_hash, frontierHash)
      );

    const a = ctx.get(BlockService).get(aHash)!;
    const aFrontierIdx = findFrontierIdx(a);
    assertNotEquals(aFrontierIdx, -1);
    assertEquals(a.outputs[aFrontierIdx].verifier.params, new Uint8Array([0]));
    assertEquals(a.outputClaims[aFrontierIdx].length, 0);

    const b = ctx.get(BlockBuilder).publish({}, 0);
    const bFrontierIdx = findFrontierIdx(b);
    assertNotEquals(bFrontierIdx, -1);
    assertEquals(b.outputs[bFrontierIdx].verifier.params, new Uint8Array([0]));

    assertEquals(ctx.get(FactService).hackyGetBlocksMatching().length, 2);

    // TODO: We shouldn't need this
    await new Promise<void>((resolve) =>
      ctx.config.timeProvider.setTimeout(resolve, 100)
    );
    assertEquals(a.outputClaims[aFrontierIdx].length, 1);
    assertEquals(b.outputClaims[bFrontierIdx].length, 1);
    assertEquals(
      a.outputClaims[aFrontierIdx][0],
      b.outputClaims[bFrontierIdx][0],
    );
  }),
);
