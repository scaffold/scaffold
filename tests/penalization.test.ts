import { assert, assertEquals, assertFalse } from 'std-latest/assert/mod.ts';
import AccountContract from '~/sbl/contracts/AccountContract.ts';
import RootContract from '~/sbl/contracts/RootContract.ts';
import { makeTest, provideInitialBalance } from '~/tests/util.ts';
import { str2bin } from '~/sbl/util/buffer.ts';
import CollateralContract from '~/sbl/contracts/CollateralContract.ts';
import BlockBuilder from '~/sbl/BlockBuilder.ts';
import { collateralHash, rootHash } from '~/sbl/constants.ts';
import Hash from '~/sbl/util/Hash.ts';
import BalanceService from '~/sbl/BalanceService.ts';
import LitigationService from '~/sbl/LitigationService.ts';

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

    const invalidBlock = ctx1.get(BlockBuilder).publish({
      body: str2bin('bad'),
      satisfies: [{
        contract_hash: rootHash,
        params: Hash.digest('good').toBytes(),
      }],
    }, 0);

    ctx1.get(LitigationService).litigate(invalidBlock, [], 'VALID_CHALLENGE');

    await new Promise<void>((resolve) =>
      ctx1.config.timeProvider.setTimeout(resolve, 10000)
    );

    assertEquals(ctx1.get(BalanceService).getLiquidBalance(), 1000000n);
  }),
);
