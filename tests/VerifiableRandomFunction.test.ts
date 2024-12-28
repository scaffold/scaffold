import { makeTest } from './util.ts';
import { Hash } from '../src/util/Hash.ts';
import { assert, assertFalse } from '@std/assert';
import { VerifiableRandomFunction } from '../src/VerifiableRandomFunction.ts';
import { KeyService } from '../src/KeyService.ts';

Deno.test(
  { name: `created output passes verification` },
  makeTest({}, (_testCtx, ctx1, ctx2) => {
    const seed = Hash.random();
    const output = ctx1.get(VerifiableRandomFunction).create(seed);
    assert(
      ctx2.get(VerifiableRandomFunction).verify(
        output,
        seed,
        ctx1.get(KeyService).getSelfPublicKey(),
      ),
    );
  }),
);

Deno.test(
  { name: `modified seed fails verification` },
  makeTest({}, (_testCtx, ctx1, ctx2) => {
    const seed = Hash.random();
    const output = ctx1.get(VerifiableRandomFunction).create(seed);
    assertFalse(
      ctx2.get(VerifiableRandomFunction).verify(
        output,
        seed.increment(),
        ctx1.get(KeyService).getSelfPublicKey(),
      ),
    );
  }),
);

Deno.test(
  { name: `modified proof fails verification` },
  makeTest({}, (_testCtx, ctx1, ctx2) => {
    const seed = Hash.random();
    const output = ctx1.get(VerifiableRandomFunction).create(seed);
    output.proof[0]++;
    assertFalse(
      ctx2.get(VerifiableRandomFunction).verify(
        output,
        seed,
        ctx1.get(KeyService).getSelfPublicKey(),
      ),
    );
  }),
);

Deno.test(
  { name: `modified random fails verification` },
  makeTest({}, (_testCtx, ctx1, ctx2) => {
    const seed = Hash.random();
    const output = ctx1.get(VerifiableRandomFunction).create(seed);
    output.random = output.random.increment();
    assertFalse(
      ctx2.get(VerifiableRandomFunction).verify(
        output,
        seed,
        ctx1.get(KeyService).getSelfPublicKey(),
      ),
    );
  }),
);
