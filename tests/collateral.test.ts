import { assertEquals, assertObjectMatch } from 'std-latest/testing/asserts.ts';
import { makeTest } from './util.ts';
import CollateralUtil, { Posting } from '~/sbl/CollateralUtil.ts';
import { CollateralContractDetail } from '~/sbl/collateralMessages.ts';

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

Deno.test(
  {
    name: `getContests test`,
    sanitizeOps: false, // TODO: Turn this on
    sanitizeResources: false,
  },
  () => {
    assertEquals(CollateralUtil.getContests([]), new Map([]));

    const p0 = makeNullPosting(pk1, 1000n, 'VALID');
    assertEquals([...CollateralUtil.getContests([p0]).values()], [{
      spec: p0.detail.contest,
      postings: [p0],
      parentHash: undefined,
      VALID: 1000n,
      INVALID: 0n,
      INCONCLUSIVE: 0n,
    }]);
  },
);
