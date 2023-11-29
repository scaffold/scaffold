import {
  assert,
  assertEquals,
  assertObjectMatch,
} from 'std-latest/testing/asserts.ts';
import { makeTest } from './util.ts';
import CollateralUtil, { Posting } from '~/sbl/CollateralUtil.ts';
import { CollateralContractDetail } from '~/sbl/collateralMessages.ts';
import { EMPTY_ARR } from '~/sbl/util/buffer.ts';
import { bin2hex } from '~/sbl/util/hex.ts';

const pkBurn = EMPTY_ARR;
const pk1 = new Uint8Array([1]);
const pk2 = new Uint8Array([2]);
const pk3 = new Uint8Array([3]);

const makeNullPosting = (
  publicKey: Uint8Array,
  amount: bigint,
  result: CollateralContractDetail['result'],
): Posting => ({
  detail: { public_key: publicKey, contest: null, result },
  amount,
});

const makeTargetedInputHashPosting = (
  publicKey: Uint8Array,
  amount: bigint,
  result: CollateralContractDetail['result'],
  inputIdx = 0,
  hint?: Uint8Array,
): Posting => ({
  detail: {
    public_key: publicKey,
    contest: {
      CollateralContest: {
        target: { CollateralTargetInputHash: { input_idx: inputIdx } },
        hint: hint ? { bytes: hint } : null,
      },
    },
    result,
  },
  amount,
});

const makeTargetedVerifierPosting = (
  publicKey: Uint8Array,
  amount: bigint,
  result: CollateralContractDetail['result'],
  inputIdx = 0,
  hint?: Uint8Array,
): Posting => ({
  detail: {
    public_key: publicKey,
    contest: {
      CollateralContest: {
        target: { CollateralTargetVerifier: { input_idx: inputIdx } },
        hint: hint ? { bytes: hint } : null,
      },
    },
    result,
  },
  amount,
});

const tests: {
  name: string;
  posting: Posting;
  winner: CollateralContractDetail['result'];
  outputs: [Uint8Array, bigint][];
}[] = [
  {
    name: 'initial',
    posting: makeNullPosting(pk1, 1000n, 'VALID'),
    winner: 'VALID',
    outputs: [[pk1, 1000n]],
  },
  {
    name: 'challenge verifier 0 invalid',
    posting: makeTargetedVerifierPosting(
      pk2,
      10n,
      'INVALID',
      0,
      new Uint8Array([123]),
    ),
    winner: 'INVALID',
    outputs: [[pk2, 20n], [pkBurn, 990n]],
  },
  {
    name: 'challenge verifier 0 inconclusive',
    posting: makeTargetedVerifierPosting(
      pk2,
      11n,
      'INCONCLUSIVE',
      0,
      new Uint8Array([123]),
    ),
    winner: 'VALID',
    outputs: [[pk1, 1003n]],
  },
  {
    name: 'challenge verifier 0 valid',
    posting: makeTargetedVerifierPosting(
      pk2,
      3n,
      'VALID',
      0,
      new Uint8Array([123]),
    ),
    winner: 'VALID',
    outputs: [[pk1, 1003n]],
  },
];

Deno.test({ name: `getContests grouping test` }, () => {
  const p0 = makeNullPosting(pk1, 1000n, 'VALID');
  const p1 = makeNullPosting(pk2, 2000n, 'INVALID');
  const p2 = makeTargetedInputHashPosting(pk1, 1000n, 'VALID');
  const p3 = makeTargetedInputHashPosting(pk2, 2000n, 'INVALID');
  const p4 = makeTargetedVerifierPosting(pk1, 1000n, 'VALID');
  const p5 = makeTargetedVerifierPosting(pk2, 2000n, 'INVALID');
  const p6 = makeTargetedVerifierPosting(pk1, 1000n, 'VALID', 1);
  const p7 = makeTargetedVerifierPosting(pk2, 2000n, 'INVALID', 1);
  const p8 = makeTargetedVerifierPosting(pk1, 1000n, 'VALID', 1, EMPTY_ARR);
  const p9 = makeTargetedVerifierPosting(pk2, 2000n, 'INVALID', 1, EMPTY_ARR);

  const expected = [{
    spec: p0.detail.contest,
    postings: [p0, p1],
    VALID: 1000n,
    INVALID: 2000n,
    INCONCLUSIVE: 0n,
  }, {
    spec: p2.detail.contest,
    postings: [p2, p3],
    VALID: 1000n,
    INVALID: 2000n,
    INCONCLUSIVE: 0n,
  }, {
    spec: p4.detail.contest,
    postings: [p4, p5],
    VALID: 1000n,
    INVALID: 2000n,
    INCONCLUSIVE: 0n,
  }, {
    spec: p6.detail.contest,
    postings: [p6, p7],
    VALID: 1000n,
    INVALID: 2000n,
    INCONCLUSIVE: 0n,
  }, {
    spec: p8.detail.contest,
    postings: [p8, p9],
    VALID: 1000n,
    INVALID: 2000n,
    INCONCLUSIVE: 0n,
  }];
  const postings = [p0, p1, p2, p3, p4, p5, p6, p7, p8, p9];
  const actual = [...CollateralUtil.getContests(postings).values()];
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
    assertObjectMatch(actual[i], expected[i]);
  }
});

Deno.test({ name: `distribution test` }, () => {
  const postings: Posting[] = [];
  for (const test of tests) {
    postings.push(test.posting);
    const contests = CollateralUtil.getContests(postings);
    const winner = CollateralUtil.getRootWinner(contests);
    assertEquals(winner, test.winner, `Unexpected winner after ${test.name}`);
    const outputMap = CollateralUtil.getOutputMap(postings, contests);
    assertEquals(
      [...outputMap.entries()].map(([pkHex, output]) => [pkHex, output.amount]),
      test.outputs.map(([pk, amount]) => [bin2hex(pk), amount]),
      `Unexpected output after ${test.name}`,
    );
  }
});
