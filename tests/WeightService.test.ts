import { assertEquals } from 'std-latest/assert/mod.ts';
import { findOutput, makeTest, provideInitialBalance } from '~/tests/util.ts';
import BlockBuilder from '~/sbl/BlockBuilder.ts';
import WeightService from '~/sbl/WeightService.ts';
import { BASE_WORK } from '~/sbl/BlockService.ts';
import { EMPTY_ARR } from '~/sbl/util/buffer.ts';
import { trueHash } from '~/sbl/constants.ts';

Deno.test(
  `self weight of an empty block`,
  makeTest({ contractProviders: [] }, (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    assertEquals(
      ctx1.get(WeightService).getSelfWeight(
        ctx1.get(BlockBuilder).publish({}, 0),
      ),
      { minWeight: BASE_WORK, maxWeight: BASE_WORK },
    );
  }),
);

Deno.test(
  `self weight of a block with a known input`,
  makeTest({ contractProviders: [] }, (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const incentiveBlock = ctx1.get(BlockBuilder).publish({
      outputs: [{
        verifier: { contract_hash: trueHash, params: EMPTY_ARR },
        amount: 123n,
        detail: EMPTY_ARR,
      }],
    }, 0);

    assertEquals(
      ctx1.get(WeightService).getSelfWeight(
        ctx1.get(BlockBuilder).publish({
          inputs: [findOutput(incentiveBlock, trueHash)],
        }, 0),
      ),
      { minWeight: BASE_WORK + 123n, maxWeight: BASE_WORK + 123n },
    );
  }),
);

Deno.test(
  `self weight of a block with an unknown input`,
  makeTest({ contractProviders: [] }, (_testCtx, ctx1, ctx2) => {
    provideInitialBalance(ctx1, ctx2);

    const incentiveBlock = ctx2.get(BlockBuilder).publish({
      outputs: [{
        verifier: { contract_hash: trueHash, params: EMPTY_ARR },
        amount: 123n,
        detail: EMPTY_ARR,
      }],
    }, 0);

    assertEquals(
      ctx1.get(WeightService).getSelfWeight(
        ctx1.get(BlockBuilder).publish({
          inputs: [findOutput(incentiveBlock, trueHash)],
        }, 0),
      ),
      { minWeight: BASE_WORK, maxWeight: BASE_WORK + 123n },
    );
  }),
);
