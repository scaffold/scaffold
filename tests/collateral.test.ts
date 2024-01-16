import { assert, assertEquals, assertFalse } from 'std-latest/assert/mod.ts';
import CollateralUtil, { Posting } from '../src/CollateralUtil.ts';
import { CollateralContractDetail } from '../src/collateralMessages.ts';
import { bin2str, str2bin } from '../src/util/buffer.ts';
import { bin2hex, hex2bin } from '../src/util/hex.ts';
import { HashPrimitive } from '../src/util/Hash.ts';
import { BlockOutput } from '../src/messages.ts';

const makePosting = (
  publicKey: string,
  amount: bigint,
  vote: CollateralContractDetail['vote'],
  hints: string[],
): Posting => ({
  amount,
  detail: { public_key: str2bin(publicKey), hints: hints.map(str2bin), vote },
});

const processOutputs = (outputMap: Map<HashPrimitive, BlockOutput>) =>
  [...outputMap.entries()].map(([pkHex, output]) =>
    [bin2str(hex2bin(pkHex)), output.amount] as const
  ).sort((a, b) => a[0].localeCompare(b[0]));

const initialPosting = makePosting('pk1', 1000n, 'VALID_CHALLENGE', []);

Deno.test({ name: `initial state test` }, () => {
  const desc = CollateralUtil.buildTree([initialPosting]);
  assertEquals(CollateralUtil.isValid(desc), true);
  assertEquals(
    processOutputs(CollateralUtil.getOutputMap(desc)),
    [['pk1', 1000n]],
  );
});

Deno.test({ name: `input challenge test` }, () => {
  const desc = CollateralUtil.buildTree([
    initialPosting,
    makePosting('pk2', 10n, 'INVALID_CHALLENGE', ['hash0']),
  ]);
  assertEquals(CollateralUtil.isValid(desc), false);
  assertEquals(
    processOutputs(CollateralUtil.getOutputMap(desc)),
    [['pk2', 1010n]],
  );
});

Deno.test({ name: `input response test` }, () => {
  const desc = CollateralUtil.buildTree([
    initialPosting,
    makePosting('pk2', 10n, 'INVALID_CHALLENGE', ['hash0']),
    makePosting('pk3', 10n, 'FINAL_PASS', ['hash0', 'textA']),
  ]);
  assertEquals(CollateralUtil.isValid(desc), true);
  assertEquals(
    processOutputs(CollateralUtil.getOutputMap(desc)),
    [['pk1', 1000n], ['pk3', 20n]],
  );
});

Deno.test({ name: `verifier challenge test` }, () => {
  const desc = CollateralUtil.buildTree([
    initialPosting,
    makePosting('pk2', 10n, 'FINAL_FAIL', ['verifier0', 'hintA']),
  ]);
  assertEquals(CollateralUtil.isValid(desc), false);
  assertEquals(
    processOutputs(CollateralUtil.getOutputMap(desc)),
    [['pk2', 1010n]],
  );
});

Deno.test({ name: `verifier battle test` }, () => {
  const desc = CollateralUtil.buildTree([
    initialPosting,
    makePosting('pk2', 10n, 'FINAL_FAIL', ['verifier0', 'hintA']),
    makePosting('pk3', 12n, 'FINAL_PASS', ['verifier0', 'hintA']),
  ]);
  assertEquals(CollateralUtil.isValid(desc), true);
  assertEquals(
    processOutputs(CollateralUtil.getOutputMap(desc)),
    [['', 4n], ['pk1', 1000n], ['pk3', 18n]],
  );
});

Deno.test({ name: `reclaim burn test` }, () => {
  const desc = CollateralUtil.buildTree([
    initialPosting,
    makePosting('pk2', 10n, 'FINAL_FAIL', ['verifier0', 'hintA']),
    makePosting('pk3', 20n, 'FINAL_PASS', ['verifier0', 'hintA']),
  ]);
  assertEquals(CollateralUtil.isValid(desc), true);
  assertEquals(
    processOutputs(CollateralUtil.getOutputMap(desc)),
    [['pk1', 1000n], ['pk3', 30n]],
  );
});

Deno.test({ name: `verifier burden of proof test` }, () => {
  const desc = CollateralUtil.buildTree([
    initialPosting,
    makePosting('pk2', 10n, 'ONE_VALID_CONTEST', ['verifier0']),
  ]);
  assertEquals(CollateralUtil.isValid(desc), true);
  assertEquals(
    processOutputs(CollateralUtil.getOutputMap(desc)),
    [['pk1', 1000n], ['pk2', 10n]],
  );
});

Deno.test({ name: `verifier burden of proof challenge test` }, () => {
  const desc = CollateralUtil.buildTree([
    initialPosting,
    makePosting('pk2', 10n, 'INVALID_CHALLENGE', ['verifier0']),
  ]);
  assertEquals(CollateralUtil.isValid(desc), false);
  assertEquals(
    processOutputs(CollateralUtil.getOutputMap(desc)),
    [['pk2', 1010n]],
  );
});

Deno.test({ name: `verifier burden of proof response test` }, () => {
  const desc = CollateralUtil.buildTree([
    initialPosting,
    makePosting('pk2', 10n, 'INVALID_CHALLENGE', ['verifier0']),
    makePosting('pk3', 20n, 'FINAL_PASS', ['verifier0', 'hintA']),
  ]);
  assertEquals(CollateralUtil.isValid(desc), true);
  assertEquals(
    processOutputs(CollateralUtil.getOutputMap(desc)),
    [['pk1', 1000n], ['pk3', 30n]],
  );
});

Deno.test({ name: `verifier claim no hint test` }, () => {
  const desc = CollateralUtil.buildTree([
    initialPosting,
    makePosting('pk2', 10n, 'INVALID_CHALLENGE', ['verifier0']),
    makePosting('pk4', 20n, 'FINAL_CONTEST', ['verifier0']),
  ]);
  assertEquals(CollateralUtil.isValid(desc), true);
  assertEquals(
    processOutputs(CollateralUtil.getOutputMap(desc)),
    [['pk1', 1000n], ['pk4', 30n]],
  );
});
