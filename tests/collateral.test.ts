import { assertEquals } from 'std-latest/testing/asserts.ts';
import CollateralUtil, { Posting } from '~/sbl/CollateralUtil.ts';
import { CollateralContractDetail } from '~/sbl/collateralMessages.ts';
import { bin2str, str2bin } from '~/sbl/util/buffer.ts';
import { bin2hex, hex2bin } from '~/sbl/util/hex.ts';

const makePosting = (
  publicKey: string,
  amount: bigint,
  vote: CollateralContractDetail['vote'],
  hints: string[],
): Posting => ({
  amount,
  detail: { public_key: str2bin(publicKey), hints: hints.map(str2bin), vote },
});

const tests: {
  name: string;
  posting: Posting;
  isValid: boolean;
  outputs: [string, bigint][];
}[] = [
  {
    name: 'initial',
    posting: makePosting('pk1', 1000n, 'VALID_CHALLENGE', []),
    isValid: true,
    outputs: [['pk1', 1000n]],
  },
  {
    name: 'challenge hash',
    posting: makePosting('pk2', 10n, 'INVALID_CHALLENGE', ['hash0']),
    isValid: false,
    outputs: [['pk2', 1010n]],
  },
  {
    name: 'provide hash inversion',
    posting: makePosting('pk3', 10n, 'FINAL_PASS', ['hash0', 'textA']),
    isValid: true,
    outputs: [['pk1', 1000n], ['pk3', 20n]],
  },
  {
    name: 'challenge verifier hint',
    posting: makePosting('pk4', 10n, 'FINAL_FAIL', ['verifier0', 'hintA']),
    isValid: false,
    outputs: [['pk3', 20n], ['pk4', 1010n]],
  },
  {
    name: 'challenge verifier hint correct',
    posting: makePosting('pk5', 12n, 'FINAL_PASS', ['verifier0', 'hintA']),
    isValid: true,
    outputs: [['pk1', 1000n], ['pk3', 20n], ['pk5', 22n]],
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
      [...outputMap.entries()].map(
        ([pkHex, output]) => [bin2str(hex2bin(pkHex)), output.amount],
      ),
      test.outputs,
      `Unexpected output after ${test.name}`,
    );
  }
});
