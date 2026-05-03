import { assertEquals } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { Output, Verifier } from '../src/core/BlockCreationModule.ts';
import { COLLATERAL_CONTRACT, RECORD_CONTRACT, SIGNATURE_CONTRACT } from '../src/core/Block.ts';
import { makeRecordOutput, recordContract } from '../src/contracts/RecordContract.ts';
import {
  type ChallengeTarget,
  type CollateralDetail,
  decodeCollateralDetail,
  encodeCollateralDetail,
  makeAgainstOutput,
  makeCollateralOutput,
} from '../src/contracts/CollateralContract.ts';
import {
  ExecutionModuleShim as ExecutionModule,
  type ExecutionProvider,
} from './testutil/ExecutionModuleShim.ts';
import {
  collateralContract,
  DECAY_CONSTANT,
  decayedValue,
  decodeVerdict,
  encodeVerdict,
  PREIMAGE_RESULT_KEY,
  readVerdictFromBlock,
  VERDICT_RECORD_KEY,
} from '../src/contracts/CollateralContract.ts';

// -- Test block type -------------------------------------------------

interface TestBlock {
  hash: Hash;
  anchor: Hash;
  outputs: Output[];
  claimIndices: number[];
  refs: Hash[];
  signer?: Uint8Array;
  timestamp: number;
}

// -- Helpers ---------------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const pubkey = (name: string): Uint8Array => enc(`pk:${name}`);

const TARGET_BLOCK = h('target-block');

function forOutput(value: number, pk: Uint8Array): Output {
  return makeCollateralOutput(TARGET_BLOCK, value, pk);
}

function againstOutput(value: number, pk: Uint8Array, target: ChallengeTarget): Output {
  return makeAgainstOutput(TARGET_BLOCK, value, pk, target);
}

function sigOutput(pk: Uint8Array, value: number): Output {
  return {
    verifier: { contract: SIGNATURE_CONTRACT, params: pk },
    value,
    data: new Uint8Array(0),
  };
}

function verdictOutput(target: Hash, verdict: 'valid' | 'invalid'): Output {
  return makeRecordOutput(VERDICT_RECORD_KEY, encodeVerdict({ target, verdict }));
}

// -- Test provider ---------------------------------------------------

class TestProvider implements ExecutionProvider<TestBlock> {
  readonly blocks = new Map<string, TestBlock>();

  addBlock(block: TestBlock): void {
    this.blocks.set(block.hash.toHex(), block);
  }

  getBlock(hash: Hash): TestBlock | undefined {
    return this.blocks.get(hash.toHex());
  }

  getOutputs(block: TestBlock): Output[] {
    return block.outputs;
  }

  getRefs(block: TestBlock): Hash[] {
    return block.refs;
  }

  getClaims(block: TestBlock): number[] {
    return block.claimIndices;
  }

  getAnchor(block: TestBlock): Hash {
    return block.anchor;
  }

  resolveClaim(block: TestBlock, claimIndex: number): Output | undefined {
    if (claimIndex < block.outputs.length) return block.outputs[claimIndex];
    if (Hash.equals(block.anchor, ZERO_HASH)) return undefined;
    const anchor = this.getBlock(block.anchor);
    if (!anchor) return undefined;
    return anchor.outputs[claimIndex - block.outputs.length];
  }

  getSigner(block: TestBlock): Uint8Array | undefined {
    return block.signer;
  }

  getTimestamp(block: TestBlock): number {
    return block.timestamp;
  }
}

function setup(): { provider: TestProvider; module: ExecutionModule<TestBlock> } {
  const provider = new TestProvider();
  const module = new ExecutionModule(provider);
  module.registerContract(COLLATERAL_CONTRACT, collateralContract);
  module.registerContract(RECORD_CONTRACT, recordContract);
  return { provider, module };
}

// -- Tests: decay math -----------------------------------------------

Deno.test('decayedValue: t=0 returns full value', () => {
  assertEquals(decayedValue(1000, 0), 1000);
});

Deno.test('decayedValue: t>0 returns less than initial', () => {
  const v = decayedValue(1000, 1000); // 1 second
  // exp(-0.0003 * 1000) = exp(-0.3) ~ 0.7408
  assertEquals(Math.round(v), 741);
});

Deno.test('decayedValue: t=30s returns near zero', () => {
  const v = decayedValue(1000, 30_000);
  // exp(-0.0003 * 30000) = exp(-9) ~ 0.000123
  assertEquals(v < 1, true);
});

Deno.test('decayedValue: negative elapsed returns full value', () => {
  assertEquals(decayedValue(1000, -100), 1000);
});

// -- Tests: decay return (no AGAINST) --------------------------------

Deno.test('Collateral: decay return -- publisher reclaims FOR when no AGAINST', async () => {
  const { provider, module } = setup();

  const pk = pubkey('author');
  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [forOutput(1000, pk)],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  const claimBlock: TestBlock = {
    hash: h('claim'),
    anchor: anchor.hash,
    // own: [sig, verdict]; anchor.own: [FOR]
    // ext: [sig(0), verdict(1), FOR(2)]
    outputs: [sigOutput(pk, 1000), verdictOutput(TARGET_BLOCK, 'valid')],
    claimIndices: [2, 1],
    refs: [],
    signer: pk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);

  const result = await module.verifyBlock(claimBlock.hash);
  assertEquals(result, { accepted: true });
});

Deno.test('Collateral: decay return rejects if not signed by FOR pubkey', async () => {
  const { provider, module } = setup();

  const authorPk = pubkey('author');
  const thiefPk = pubkey('thief');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [forOutput(1000, authorPk)],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  const claimBlock: TestBlock = {
    hash: h('claim'),
    anchor: anchor.hash,
    outputs: [sigOutput(authorPk, 1000)],
    claimIndices: [1],
    refs: [],
    signer: thiefPk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);

  const result = await module.verifyBlock(claimBlock.hash);
  assertEquals(result.accepted, false);
});

Deno.test('Collateral: decay return rejects wrong output value', async () => {
  const { provider, module } = setup();

  const pk = pubkey('author');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [forOutput(1000, pk)],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  const claimBlock: TestBlock = {
    hash: h('claim'),
    anchor: anchor.hash,
    outputs: [sigOutput(pk, 9999)],
    claimIndices: [1],
    refs: [],
    signer: pk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);

  const result = await module.verifyBlock(claimBlock.hash);
  assertEquals(result.accepted, false);
});

// -- Tests: unresolved challenge (AGAINST wins) -----------------------

Deno.test('Collateral: unresolved challenge -- challenger claims FOR + own bond', async () => {
  const { provider, module } = setup();

  const authorPk = pubkey('author');
  const challengerPk = pubkey('challenger');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [forOutput(1000, authorPk), againstOutput(50, challengerPk, { type: 'validity' })],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  const claimBlock: TestBlock = {
    hash: h('claim'),
    anchor: anchor.hash,
    // own: [sig, verdict]; anchor.own: [FOR, AGAINST]
    // ext: [sig(0), verdict(1), FOR(2), AGAINST(3)]
    outputs: [sigOutput(challengerPk, 50 + 1000), verdictOutput(TARGET_BLOCK, 'invalid')],
    claimIndices: [2, 3, 1],
    refs: [],
    signer: challengerPk,
    timestamp: 5000,
  };
  provider.addBlock(claimBlock);

  const result = await module.verifyBlock(claimBlock.hash);
  assertEquals(result, { accepted: true });
});

Deno.test('Collateral: unresolved challenge rejects wrong payout', async () => {
  const { provider, module } = setup();

  const authorPk = pubkey('author');
  const challengerPk = pubkey('challenger');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [forOutput(1000, authorPk), againstOutput(50, challengerPk, { type: 'validity' })],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  const claimBlock: TestBlock = {
    hash: h('claim'),
    anchor: anchor.hash,
    outputs: [sigOutput(challengerPk, 999)], // wrong amount
    claimIndices: [1, 2],
    refs: [],
    signer: challengerPk,
    timestamp: 5000,
  };
  provider.addBlock(claimBlock);

  const result = await module.verifyBlock(claimBlock.hash);
  assertEquals(result.accepted, false);
});

// -- Tests: hash challenge response -----------------------------------

Deno.test('Collateral: hash challenge response -- responder earns AGAINST bond', async () => {
  const { provider, module } = setup();

  const authorPk = pubkey('author');
  const challengerPk = pubkey('challenger');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [
      forOutput(1000, authorPk),
      againstOutput(50, challengerPk, { type: 'anchor' }),
    ],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  // Responder (author) reveals preimage, gets AGAINST bond + own FOR back
  const claimBlock: TestBlock = {
    hash: h('claim'),
    anchor: anchor.hash,
    // own: [sig1000, sig50, preimage, verdict]; anchor.own: [FOR, AGAINST]
    // ext: [own0(0), own1(1), preimage(2), verdict(3), FOR(4), AGAINST(5)]
    outputs: [
      sigOutput(authorPk, 1000), // FOR returned
      sigOutput(authorPk, 50), // AGAINST bond earned
      makeRecordOutput(PREIMAGE_RESULT_KEY, PREIMAGE_RESULT_KEY), // preimage result
      verdictOutput(TARGET_BLOCK, 'valid'),
    ],
    claimIndices: [4, 5, 2, 3], // FOR, AGAINST, self-claim preimage, self-claim verdict
    refs: [],
    signer: authorPk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);

  const result = await module.verifyBlock(claimBlock.hash);
  assertEquals(result, { accepted: true });
});

// -- Tests: non-canonical reclaim ------------------------------------

Deno.test('Collateral: non-canonical reclaim -- full return to both sides', async () => {
  const { provider, module } = setup();

  const authorPk = pubkey('author');
  const challengerPk = pubkey('challenger');
  const reclaimerPk = pubkey('reclaimer');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [
      forOutput(1000, authorPk),
      againstOutput(50, challengerPk, { type: 'validity' }),
    ],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  // Block signed by third party (neither FOR nor AGAINST pubkey)
  // triggers non-canonical reclaim -- full return to both
  const claimBlock: TestBlock = {
    hash: h('claim'),
    anchor: anchor.hash,
    outputs: [
      sigOutput(authorPk, 1000), // FOR returned to author
      sigOutput(challengerPk, 50), // AGAINST returned to challenger
    ],
    claimIndices: [2, 3],
    refs: [],
    signer: reclaimerPk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);

  const result = await module.verifyBlock(claimBlock.hash);
  assertEquals(result, { accepted: true });
});

// -- Tests: multiple AGAINST on same block ----------------------------

Deno.test('Collateral: multiple AGAINST challengers each get FOR + own bond', async () => {
  const { provider, module } = setup();

  const authorPk = pubkey('author');
  const ch1 = pubkey('challenger1');
  const ch2 = pubkey('challenger2');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [
      forOutput(1000, authorPk),
      againstOutput(30, ch1, { type: 'validity' }),
      againstOutput(20, ch2, { type: 'anchor' }),
    ],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  // Extended outputs: [own[0], own[1], anchor[0]=FOR, anchor[1]=AGAINST1, anchor[2]=AGAINST2]
  // challenger1 claims: gets own 30 + FOR 1000
  // challenger2 claims: gets own 20 + FOR 1000
  const claimBlock: TestBlock = {
    hash: h('claim'),
    anchor: anchor.hash,
    // own: [sig-ch1, sig-ch2, verdict]; anchor.own: [FOR, A1, A2]
    // ext: [own0(0), own1(1), verdict(2), FOR(3), A1(4), A2(5)]
    outputs: [
      sigOutput(ch1, 30 + 1000),
      sigOutput(ch2, 20 + 1000),
      verdictOutput(TARGET_BLOCK, 'invalid'),
    ],
    claimIndices: [3, 4, 5, 2], // FOR + both AGAINST + self-claim verdict
    refs: [],
    signer: ch1,
    timestamp: 5000,
  };
  provider.addBlock(claimBlock);

  const result = await module.verifyBlock(claimBlock.hash);
  assertEquals(result, { accepted: true });
});

// -- Tests: challenge targets -----------------------------------------

Deno.test('Collateral: AGAINST with each ChallengeTarget type', async () => {
  const targets: ChallengeTarget[] = [
    { type: 'validity' },
    { type: 'anchor' },
    { type: 'ref', index: 0 },
    { type: 'aggregate', index: 2 },
    { type: 'output_verifier_contract', index: 5 },
  ];

  for (const target of targets) {
    const { provider, module } = setup();
    const authorPk = pubkey('author');
    const challengerPk = pubkey('challenger');

    const anchor: TestBlock = {
      hash: h(`anchor-${target.type}`),
      anchor: ZERO_HASH,
      outputs: [forOutput(500, authorPk), againstOutput(25, challengerPk, target)],
      claimIndices: [],
      refs: [],
      timestamp: 1000,
    };
    provider.addBlock(anchor);

    const claimBlock: TestBlock = {
      hash: h(`claim-${target.type}`),
      anchor: anchor.hash,
      // own: [sig, verdict]; anchor.own: [FOR, AGAINST]
      // ext: [sig(0), verdict(1), FOR(2), AGAINST(3)]
      outputs: [sigOutput(challengerPk, 25 + 500), verdictOutput(TARGET_BLOCK, 'invalid')],
      claimIndices: [2, 3, 1],
      refs: [],
      signer: challengerPk,
      timestamp: 2000,
    };
    provider.addBlock(claimBlock);

    const result = await module.verifyBlock(claimBlock.hash);
    assertEquals(result, { accepted: true }, `failed for target type: ${target.type}`);
  }
});

// -- Tests: encode/decode round-trip ---------------------------------

Deno.test('Collateral: FOR detail round-trips through encode/decode', () => {
  const pk = pubkey('test');
  const detail: CollateralDetail = { side: 'for', pubkey: pk };
  const encoded = encodeCollateralDetail(detail);
  const result = decodeCollateralDetail(encoded);
  assertEquals(result.side, 'for');
  assertEquals(result.pubkey, pk);
});

Deno.test('Collateral: AGAINST detail round-trips through encode/decode', () => {
  const pk = pubkey('test');
  const target: ChallengeTarget = { type: 'ref', index: 3 };
  const detail: CollateralDetail = { side: 'against', pubkey: pk, target };
  const encoded = encodeCollateralDetail(detail);
  const result = decodeCollateralDetail(encoded);
  assertEquals(result.side, 'against');
  if (result.side === 'against') {
    assertEquals(result.target, target);
  }
});

// -- Tests: verdict record output ------------------------------------

Deno.test('Collateral: verdict record round-trips through encode/decode', () => {
  const v = { target: TARGET_BLOCK, verdict: 'valid' as const };
  assertEquals(decodeVerdict(encodeVerdict(v)), v);
  const v2 = { target: TARGET_BLOCK, verdict: 'invalid' as const };
  assertEquals(decodeVerdict(encodeVerdict(v2)), v2);
});

Deno.test('Collateral: Mode 1 (decay return) emits verdict=valid', async () => {
  const { provider, module } = setup();
  const pk = pubkey('author');
  const anchor: TestBlock = {
    hash: h('anchor-m1-verdict'),
    anchor: ZERO_HASH,
    outputs: [forOutput(1000, pk)],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);
  const claimBlock: TestBlock = {
    hash: h('claim-m1-verdict'),
    anchor: anchor.hash,
    outputs: [sigOutput(pk, 1000), verdictOutput(TARGET_BLOCK, 'valid')],
    claimIndices: [2, 1],
    refs: [],
    signer: pk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);
  assertEquals((await module.verifyBlock(claimBlock.hash)).accepted, true);
  const v = readVerdictFromBlock(claimBlock);
  assertEquals(v?.verdict, 'valid');
  assertEquals(v?.target.toHex(), TARGET_BLOCK.toHex());
});

Deno.test('Collateral: Mode 1 rejects block with wrong verdict value', async () => {
  const { provider, module } = setup();
  const pk = pubkey('author');
  const anchor: TestBlock = {
    hash: h('anchor-m1-bad'),
    anchor: ZERO_HASH,
    outputs: [forOutput(1000, pk)],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);
  // Attempt to lie: Mode 1 must be 'valid', but we post 'invalid'.
  const claimBlock: TestBlock = {
    hash: h('claim-m1-bad'),
    anchor: anchor.hash,
    outputs: [sigOutput(pk, 1000), verdictOutput(TARGET_BLOCK, 'invalid')],
    claimIndices: [2, 1],
    refs: [],
    signer: pk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);
  assertEquals((await module.verifyBlock(claimBlock.hash)).accepted, false);
});

Deno.test('Collateral: Mode 2 (hash challenge response) emits verdict=valid', async () => {
  const { provider, module } = setup();
  const authorPk = pubkey('author');
  const challengerPk = pubkey('challenger');
  const anchor: TestBlock = {
    hash: h('anchor-m2-verdict'),
    anchor: ZERO_HASH,
    outputs: [
      forOutput(1000, authorPk),
      againstOutput(50, challengerPk, { type: 'anchor' }),
    ],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);
  const claimBlock: TestBlock = {
    hash: h('claim-m2-verdict'),
    anchor: anchor.hash,
    outputs: [
      sigOutput(authorPk, 1000),
      sigOutput(authorPk, 50),
      makeRecordOutput(PREIMAGE_RESULT_KEY, PREIMAGE_RESULT_KEY),
      verdictOutput(TARGET_BLOCK, 'valid'),
    ],
    claimIndices: [4, 5, 2, 3],
    refs: [],
    signer: authorPk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);
  assertEquals((await module.verifyBlock(claimBlock.hash)).accepted, true);
  assertEquals(readVerdictFromBlock(claimBlock)?.verdict, 'valid');
});

Deno.test('Collateral: Mode 3 (unresolved challenge) emits verdict=invalid', async () => {
  const { provider, module } = setup();
  const authorPk = pubkey('author');
  const challengerPk = pubkey('challenger');
  const anchor: TestBlock = {
    hash: h('anchor-m3-verdict'),
    anchor: ZERO_HASH,
    outputs: [
      forOutput(1000, authorPk),
      againstOutput(50, challengerPk, { type: 'validity' }),
    ],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);
  const claimBlock: TestBlock = {
    hash: h('claim-m3-verdict'),
    anchor: anchor.hash,
    outputs: [
      sigOutput(challengerPk, 50 + 1000),
      verdictOutput(TARGET_BLOCK, 'invalid'),
    ],
    claimIndices: [2, 3, 1],
    refs: [],
    signer: challengerPk,
    timestamp: 5000,
  };
  provider.addBlock(claimBlock);
  assertEquals((await module.verifyBlock(claimBlock.hash)).accepted, true);
  assertEquals(readVerdictFromBlock(claimBlock)?.verdict, 'invalid');
  assertEquals(readVerdictFromBlock(claimBlock)?.target.toHex(), TARGET_BLOCK.toHex());
});

Deno.test('Collateral: Mode 4 (non-canonical reclaim) emits NO verdict output', async () => {
  const { provider, module } = setup();
  const authorPk = pubkey('author');
  const challengerPk = pubkey('challenger');
  const reclaimerPk = pubkey('reclaimer');
  const anchor: TestBlock = {
    hash: h('anchor-m4-verdict'),
    anchor: ZERO_HASH,
    outputs: [
      forOutput(1000, authorPk),
      againstOutput(50, challengerPk, { type: 'validity' }),
    ],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);
  const claimBlock: TestBlock = {
    hash: h('claim-m4-verdict'),
    anchor: anchor.hash,
    outputs: [
      sigOutput(authorPk, 1000),
      sigOutput(challengerPk, 50),
    ],
    claimIndices: [2, 3],
    refs: [],
    signer: reclaimerPk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);
  assertEquals((await module.verifyBlock(claimBlock.hash)).accepted, true);
  assertEquals(readVerdictFromBlock(claimBlock), undefined);
});
