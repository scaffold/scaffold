import { assert } from '../test_deps.ts';
import {
  bigint2bin,
  bin2bigint,
  countTrailingZeros,
} from '../src/util/bigint.ts';

Deno.test({ name: `count trailing zeros` }, () => {
  assert.assertEquals(countTrailingZeros(5n), 0);
  assert.assertEquals(countTrailingZeros(6n), 1);
  assert.assertEquals(countTrailingZeros(8n), 3);
});

Deno.test({ name: `binary to bigint` }, () => {
  assert.assertEquals(bin2bigint(new Uint8Array([])), 0n);
  assert.assertEquals(bin2bigint(new Uint8Array([7])), 7n);
  assert.assertEquals(bin2bigint(new Uint8Array([255])), 255n);
  assert.assertEquals(bin2bigint(new Uint8Array([0, 1])), 256n);
  assert.assertEquals(bin2bigint(new Uint8Array([7, 1])), 263n);
});

Deno.test({ name: `bigint to binary` }, () => {
  assert.assertEquals(bigint2bin(0n), new Uint8Array([]));
  assert.assertEquals(bigint2bin(7n), new Uint8Array([7]));
  assert.assertEquals(bigint2bin(255n), new Uint8Array([255]));
  assert.assertEquals(bigint2bin(256n), new Uint8Array([0, 1]));
  assert.assertEquals(bigint2bin(263n), new Uint8Array([7, 1]));
});

Deno.test({ name: `big number` }, () => {
  const t = 13473837727108541341n;
  assert.assertEquals(bin2bigint(bigint2bin(t, 8)), t);
});

Deno.test({ name: `adding extra zeros doesn't change the number` }, () => {
  assert.assertEquals(bin2bigint(new Uint8Array([5, 0, 0, 0, 0])), 5n);
});
