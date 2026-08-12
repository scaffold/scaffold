import { assertEquals, assertRejects } from '@std/assert';
import {
  aggregationContract,
  serializeAggregationParams,
} from '../../../src/contract/static/Aggregation.ts';
import { createSink } from '../../../src/contract/createSink.ts';
import { createSource } from '../../../src/contract/createSource.ts';

Deno.test('aggregation params are built from a level', async () => {
  assertEquals(
    await aggregationContract.buildParams!(() => createSource({ level: 3 })),
    serializeAggregationParams({ level: 3 }),
  );
});

Deno.test('walking aggregation params exposes the level', async () => {
  assertEquals(
    await createSink((sink) =>
      aggregationContract.walkParams!(serializeAggregationParams({ level: 3 }), sink)
    ),
    { level: 3 },
  );
});

Deno.test('a level that is not a whole byte is rejected', async () => {
  await assertRejects(async () => {
    await aggregationContract.buildParams!(() => createSource({ level: 1.5 }));
  });
  await assertRejects(async () => {
    await aggregationContract.buildParams!(() => createSource({ level: 256 }));
  });
});

Deno.test('a level that is not a number is rejected', async () => {
  await assertRejects(async () => {
    await aggregationContract.buildParams!(() => createSource({ level: '3' }));
  });
});
