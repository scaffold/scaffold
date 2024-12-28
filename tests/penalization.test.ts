import { assertEquals, assertStrictEquals } from '$std/assert/mod.ts';
import { AccountContract } from '../src/contracts/AccountContract.ts';
import { RootContract } from '../src/contracts/RootContract.ts';
import { makeTest, provideInitialBalance } from '../tests/util.ts';
import { str2bin } from '../src/util/buffer.ts';
import { CollateralContract } from '../src/contracts/CollateralContract.ts';
import { BlockBuilder } from '../src/BlockBuilder.ts';
import { collateralHash, rootHash } from '../src/constants.ts';
import { Hash } from '../src/util/Hash.ts';
import { BalanceService } from '../src/BalanceService.ts';
import { LitigationService } from '../src/LitigationService.ts';

Deno.test(
  {
    name: `an invalid block should decrease the available account balance`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
    ignore: true, // We need to fix BalanceService to only accumulate canonical account outputs
  },
  makeTest({
    contractProviders: [
      new AccountContract(),
      new RootContract(),
      new CollateralContract(),
    ],
  }, async (_testCtx, ctx1, ctx2) => {
    provideInitialBalance(ctx1, ctx2);

    assertEquals(ctx1.get(BalanceService).getLiquidBalance(), 1000000n);

    const invalidBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      body: str2bin('bad'),
      satisfies: [{
        contractHash: rootHash,
        params: Hash.digest('good').toBytes(),
      }],
    });

    ctx1.get(LitigationService).litigate(invalidBlock, [], 'VALID_CHALLENGE');

    await new Promise<void>((resolve) =>
      ctx1.config.timeProvider.setTimeout(resolve, 10000)
    );

    // assertEquals(ctx1.get(BalanceService).getLiquidBalance(), 1000000n);
  }),
);
