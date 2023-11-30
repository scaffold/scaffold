import {
  assert,
  assertEquals,
  assertObjectMatch,
} from 'std-latest/testing/asserts.ts';
import { makeTest } from './util.ts';
import CollateralUtil, { Posting } from '~/sbl/CollateralUtil.ts';
import { CollateralContractDetail } from '~/sbl/collateralMessages.ts';
import { EMPTY_ARR, str2bin } from '~/sbl/util/buffer.ts';
import { bin2hex } from '~/sbl/util/hex.ts';

const pkBurn = EMPTY_ARR;
const pk1 = new Uint8Array([1]);
const pk2 = new Uint8Array([2]);
const pk3 = new Uint8Array([3]);
const pk4 = new Uint8Array([4]);

const makePosting = (
  publicKey: Uint8Array,
  amount: bigint,
  vote: CollateralContractDetail['vote'],
  hints: string[],
): Posting => ({
  amount,
  detail: { public_key: publicKey, hints: hints.map(str2bin), vote },
});

const tests: {
  name: string;
  posting: Posting;
  isValid: boolean;
  outputs: [Uint8Array, bigint][];
}[] = [
  {
    name: 'initial',
    posting: makePosting(pk1, 1000n, 'VALID_CHALLENGE', []),
    isValid: true,
    outputs: [[pk1, 1000n]],
  },
  {
    name: 'challenge hash',
    posting: makePosting(pk2, 10n, 'INVALID_CHALLENGE', ['hash0']),
    isValid: false,
    outputs: [[pk2, 1010n]],
  },
  {
    name: 'provide hash inversion',
    posting: makePosting(pk3, 10n, 'FINAL_PASS', ['hash0', 'textA']),
    isValid: true,
    outputs: [[pk1, 1000n], [pk3, 20n]],
  },
  {
    name: 'challenge verifier hint',
    posting: makePosting(pk4, 10n, 'FINAL_FAIL', ['verifier0', 'hintA']),
    isValid: false,
    outputs: [[pk3, 20n], [pk4, 1010n]],
  },
];

Deno.test({ name: `distribution test` }, () => {
  const postings: Posting[] = [];
  for (const test of tests) {
    postings.push(test.posting);
    const desc = CollateralUtil.buildTree(postings);
    const isValid = CollateralUtil.isValid(desc);
    assertEquals(
      isValid,
      test.isValid,
      `Unexpected isValid after ${test.name}`,
    );
    const outputMap = CollateralUtil.getOutputMap(desc);
    assertEquals(
      [...outputMap.entries()].map(([pkHex, output]) => [pkHex, output.amount]),
      test.outputs.map(([pk, amount]) => [bin2hex(pk), amount]),
      `Unexpected output after ${test.name}`,
    );
  }
});
