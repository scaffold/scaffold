import { assertEquals } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { Output, Verifier } from '../src/core/BlockCreationModule.ts';
import {
  COLLATERAL_CONTRACT,
  RECORD_CONTRACT,
  SIGNATURE_CONTRACT,
} from '../src/core/Block.ts';
import { makeRecordOutput } from '../src/contracts/RecordContract.ts';
import {
  type ChallengeTarget,
  type CollateralDetail,
  decodeCollateralDetail,
  encodeCollateralDetail,
  makeAgainstOutput,
  makeCollateralOutput,
} from '../src/contracts/CollateralContract.ts';
import { ExecutionModule, type ExecutionProvider } from '../src/core/ExecutionModule.ts';
import {
  collateralContract,
  decayedValue,
  DECAY_CONSTANT,
  PREIMAGE_RESULT_KEY,
} from '../src/contracts/CollateralContract.ts';

// -- Test block type -------------------------------------------------

interface TestBlock {
  hash: Hash;
  anchor: Hash;
  outputs: Output[];
  claims: number[];
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
    return block.claims;
  }

  getAnchor(block: TestBlock): Hash {
    return block.anchor;
  }

  getExtendedOutputs(block: TestBlock): Output[] {
    const result: Output[] = [...block.outputs];
    if (Hash.equals(block.anchor, ZERO_HASH)) return result;
    const anchor = this.getBlock(block.anchor);
    if (anchor) result.push(...anchor.outputs);
    return result;
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

Deno.test('Collateral: decay return -- publisher reclaims FOR when no AGAINST', () => {
  const { provider, module } = setup();

  const pk = pubkey('author');
  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [forOutput(1000, pk)],
    claims: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  const claimBlock: TestBlock = {
    hash: h('claim'),
    anchor: anchor.hash,
    outputs: [sigOutput(pk, 1000)],
    claims: [1],
    refs: [],
    signer: pk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);

  const result = module.verifyBlock(claimBlock.hash);
  assertEquals(result, { accepted: true });
});

Deno.test('Collateral: decay return rejects if not signed by FOR pubkey', () => {
  const { provider, module } = setup();

  const authorPk = pubkey('author');
  const thiefPk = pubkey('thief');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [forOutput(1000, authorPk)],
    claims: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  const claimBlock: TestBlock = {
    hash: h('claim'),
    anchor: anchor.hash,
    outputs: [sigOutput(authorPk, 1000)],
    claims: [1],
    refs: [],
    signer: thiefPk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);

  const result = module.verifyBlock(claimBlock.hash);
  assertEquals(result.accepted, false);
});

Deno.test('Collateral: decay return rejects wrong output value', () => {
  const { provider, module } = setup();

  const pk = pubkey('author');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [forOutput(1000, pk)],
    claims: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  const claimBlock: TestBlock = {
    hash: h('claim'),
    anchor: anchor.hash,
    outputs: [sigOutput(pk, 9999)],
    claims: [1],
    refs: [],
    signer: pk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);

  const result = module.verifyBlock(claimBlock.hash);
  assertEquals(result.accepted, false);
});

// -- Tests: unresolved challenge (AGAINST wins) -----------------------

Deno.test('Collateral: unresolved challenge -- challenger claims FOR + own bond', () => {
  const { provider, module } = setup();

  const authorPk = pubkey('author');
  const challengerPk = pubkey('challenger');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [forOutput(1000, authorPk), againstOutput(50, challengerPk, { type: 'validity' })],
    claims: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  const claimBlock: TestBlock = {
    hash: h('claim'),
    anchor: anchor.hash,
    outputs: [sigOutput(challengerPk, 50 + 1000)],
    claims: [1, 2],
    refs: [],
    signer: challengerPk,
    timestamp: 5000,
  };
  provider.addBlock(claimBlock);

  const result = module.verifyBlock(claimBlock.hash);
  assertEquals(result, { accepted: true });
});

Deno.test('Collateral: unresolved challenge rejects wrong payout', () => {
  const { provider, module } = setup();

  const authorPk = pubkey('author');
  const challengerPk = pubkey('challenger');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [forOutput(1000, authorPk), againstOutput(50, challengerPk, { type: 'validity' })],
    claims: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  const claimBlock: TestBlock = {
    hash: h('claim'),
    anchor: anchor.hash,
    outputs: [sigOutput(challengerPk, 999)], // wrong amount
    claims: [1, 2],
    refs: [],
    signer: challengerPk,
    timestamp: 5000,
  };
  provider.addBlock(claimBlock);

  const result = module.verifyBlock(claimBlock.hash);
  assertEquals(result.accepted, false);
});

// -- Tests: hash challenge response -----------------------------------

Deno.test('Collateral: hash challenge response -- responder earns AGAINST bond', () => {
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
    claims: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  // Responder (author) reveals preimage, gets AGAINST bond + own FOR back
  const claimBlock: TestBlock = {
    hash: h('claim'),
    anchor: anchor.hash,
    outputs: [
      sigOutput(authorPk, 1000), // FOR returned
      sigOutput(authorPk, 50), // AGAINST bond earned
      makeRecordOutput(PREIMAGE_RESULT_KEY, PREIMAGE_RESULT_KEY), // preimage result
    ],
    claims: [3, 4, 2], // claims anchor's FOR (ext[3]) and AGAINST (ext[4]), self-claims result (own[2])
    refs: [],
    signer: authorPk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);

  const result = module.verifyBlock(claimBlock.hash);
  assertEquals(result, { accepted: true });
});

// -- Tests: non-canonical reclaim ------------------------------------

Deno.test('Collateral: non-canonical reclaim -- full return to both sides', () => {
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
    claims: [],
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
    claims: [2, 3],
    refs: [],
    signer: reclaimerPk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);

  const result = module.verifyBlock(claimBlock.hash);
  assertEquals(result, { accepted: true });
});

// -- Tests: multiple AGAINST on same block ----------------------------

Deno.test('Collateral: multiple AGAINST challengers each get FOR + own bond', () => {
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
    claims: [],
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
    outputs: [
      sigOutput(ch1, 30 + 1000),
      sigOutput(ch2, 20 + 1000),
    ],
    claims: [2, 3, 4], // anchor's FOR (ext[2]) + both AGAINST (ext[3], ext[4])
    refs: [],
    signer: ch1,
    timestamp: 5000,
  };
  provider.addBlock(claimBlock);

  const result = module.verifyBlock(claimBlock.hash);
  assertEquals(result, { accepted: true });
});

// -- Tests: challenge targets -----------------------------------------

Deno.test('Collateral: AGAINST with each ChallengeTarget type', () => {
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
      claims: [],
      refs: [],
      timestamp: 1000,
    };
    provider.addBlock(anchor);

    const claimBlock: TestBlock = {
      hash: h(`claim-${target.type}`),
      anchor: anchor.hash,
      outputs: [sigOutput(challengerPk, 25 + 500)],
      claims: [1, 2],
      refs: [],
      signer: challengerPk,
      timestamp: 2000,
    };
    provider.addBlock(claimBlock);

    const result = module.verifyBlock(claimBlock.hash);
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
