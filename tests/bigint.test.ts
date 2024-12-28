import { assertEquals } from '@std/assert';
import {
  bigint2bin,
  bin2bigint,
  countTrailingZeros,
} from '../src/util/bigint.ts';

Deno.test({ name: `count trailing zeros` }, () => {
  assertEquals(countTrailingZeros(5n), 0);
  assertEquals(countTrailingZeros(6n), 1);
  assertEquals(countTrailingZeros(8n), 3);
});

Deno.test({ name: `binary to bigint` }, () => {
  assertEquals(bin2bigint(new Uint8Array([])), 0n);
  assertEquals(bin2bigint(new Uint8Array([7])), 7n);
  assertEquals(bin2bigint(new Uint8Array([255])), 255n);
  assertEquals(bin2bigint(new Uint8Array([0, 1])), 256n);
  assertEquals(bin2bigint(new Uint8Array([7, 1])), 263n);
});

Deno.test({ name: `bigint to binary` }, () => {
  assertEquals(bigint2bin(0n), new Uint8Array([]));
  assertEquals(bigint2bin(7n), new Uint8Array([7]));
  assertEquals(bigint2bin(255n), new Uint8Array([255]));
  assertEquals(bigint2bin(256n), new Uint8Array([0, 1]));
  assertEquals(bigint2bin(263n), new Uint8Array([7, 1]));
});

Deno.test({ name: `big number` }, () => {
  const t = 13473837727108541341n;
  assertEquals(bin2bigint(bigint2bin(t, 8)), t);
});

Deno.test({ name: `adding extra zeros doesn't change the number` }, () => {
  assertEquals(bin2bigint(new Uint8Array([5, 0, 0, 0, 0])), 5n);
});
