import { assert } from '../test_deps.ts';
import { findOutput, makeTest, provideInitialBalance } from '../tests/util.ts';
import { BlockBuilder } from '../src/BlockBuilder.ts';
import { WeightService } from '../src/WeightService.ts';
import { BASE_WORK } from '../src/BlockService.ts';
import { EMPTY_ARR } from '../src/util/buffer.ts';
import { trueHash } from '../src/constants.ts';

Deno.test(
  `self weight of an empty block`,
  makeTest({ contractProviders: [] }, (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    assert.assertEquals(
      ctx1.get(WeightService).getSelfWeight(
        ctx1.get(BlockBuilder).publishSingleDraft({}),
      ),
      { minWeight: BASE_WORK, maxWeight: BASE_WORK },
    );
  }),
);

Deno.test(
  `self weight of a block with a known input`,
  makeTest({ contractProviders: [] }, (_testCtx, ctx1) => {
    provideInitialBalance(ctx1);

    const incentiveBlock = ctx1.get(BlockBuilder).publishSingleDraft({
      outputs: [{
        verifier: { contractHash: trueHash, params: EMPTY_ARR },
        amount: 123n,
        detail: EMPTY_ARR,
      }],
    });

    assert.assertEquals(
      ctx1.get(WeightService).getSelfWeight(
        ctx1.get(BlockBuilder).publishSingleDraft({
          inputs: [findOutput(incentiveBlock, trueHash)],
        }),
      ),
      { minWeight: BASE_WORK + 123n, maxWeight: BASE_WORK + 123n },
    );
  }),
);

Deno.test(
  `self weight of a block with an unknown input`,
  makeTest({ contractProviders: [] }, (_testCtx, ctx1, ctx2) => {
    provideInitialBalance(ctx1, ctx2);

    const incentiveBlock = ctx2.get(BlockBuilder).publishSingleDraft({
      outputs: [{
        verifier: { contractHash: trueHash, params: EMPTY_ARR },
        amount: 123n,
        detail: EMPTY_ARR,
      }],
    });

    assert.assertEquals(
      ctx1.get(WeightService).getSelfWeight(
        ctx1.get(BlockBuilder).publishSingleDraft({
          inputs: [findOutput(incentiveBlock, trueHash)],
        }),
      ),
      { minWeight: BASE_WORK, maxWeight: BASE_WORK + 123n },
    );
  }),
);
