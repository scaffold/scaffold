import { assertEquals } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { Output, Verifier } from '../src/core/BlockCreationModule.ts';
import {
  INSURANCE_CONTRACT,
  SIGNATURE_CONTRACT,
} from '../src/core/Block.ts';
import {
  decodeInsuranceDetail,
  encodeInsuranceDetail,
  type InsuranceDetail,
  makeInsuranceOutput,
} from '../src/contracts/InsuranceContract.ts';
import {
  ExecutionModuleShim as ExecutionModule,
  type ExecutionProvider,
} from './testutil/ExecutionModuleShim.ts';
import { insuranceContract, FINDER_SHARE, MIN_RETURN_RATE } from '../src/contracts/InsuranceContract.ts';

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

function insOutput(value: number, pk: Uint8Array): Output {
  return makeInsuranceOutput(TARGET_BLOCK, value, pk);
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
  module.registerContract(INSURANCE_CONTRACT, insuranceContract);
  return { provider, module };
}

// -- Tests: aggregation claim ----------------------------------------

Deno.test('Insurance: aggregation claim -- returns deposit minus fee to author', async () => {
  const { provider, module } = setup();

  const authorPk = pubkey('author');
  const aggregatorPk = pubkey('aggregator');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [insOutput(1000, authorPk)],
    claims: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  // Aggregator claims insurance, returns 950 (95%) to author, keeps 50 fee
  const minReturn = Math.floor(1000 * MIN_RETURN_RATE);
  const claimBlock: TestBlock = {
    hash: h('aggregation'),
    anchor: anchor.hash,
    outputs: [sigOutput(authorPk, minReturn)],
    claims: [1],
    refs: [],
    signer: aggregatorPk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);

  const result = await module.verifyBlock(claimBlock.hash);
  assertEquals(result, { accepted: true });
});

Deno.test('Insurance: aggregation claim rejects if return too small', async () => {
  const { provider, module } = setup();

  const authorPk = pubkey('author');
  const aggregatorPk = pubkey('aggregator');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [insOutput(1000, authorPk)],
    claims: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  // Aggregator tries to keep too much (returns only 500)
  const claimBlock: TestBlock = {
    hash: h('aggregation'),
    anchor: anchor.hash,
    outputs: [sigOutput(authorPk, 500)],
    claims: [1],
    refs: [],
    signer: aggregatorPk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);

  const result = await module.verifyBlock(claimBlock.hash);
  assertEquals(result.accepted, false);
});

// -- Tests: solidification return ------------------------------------

Deno.test('Insurance: solidification return -- owner reclaims full value', async () => {
  const { provider, module } = setup();

  const aggregatorPk = pubkey('aggregator');
  // Aggregator's own insurance covering a tree
  const treeRoot = h('tree-root');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [makeInsuranceOutput(treeRoot, 2500, aggregatorPk)],
    claims: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  // Aggregator reclaims after solidification -- signed by owner, full return
  const claimBlock: TestBlock = {
    hash: h('solidify'),
    anchor: anchor.hash,
    outputs: [sigOutput(aggregatorPk, 2500)],
    claims: [1],
    refs: [],
    signer: aggregatorPk,
    timestamp: 100_000, // much later
  };
  provider.addBlock(claimBlock);

  // Need to register the contract for this verifier (tree-root params)
  const module2 = new ExecutionModule(provider);
  module2.registerContract(INSURANCE_CONTRACT, insuranceContract);

  const result = await module2.verifyBlock(claimBlock.hash);
  assertEquals(result, { accepted: true });
});

// -- Tests: non-canonical reclaim ------------------------------------

Deno.test('Insurance: non-canonical reclaim -- owner gets full return', async () => {
  const { provider, module } = setup();

  const authorPk = pubkey('author');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [insOutput(1000, authorPk)],
    claims: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  // Author reclaims own insurance (non-canonical target)
  const claimBlock: TestBlock = {
    hash: h('reclaim'),
    anchor: anchor.hash,
    outputs: [sigOutput(authorPk, 1000)],
    claims: [1],
    refs: [],
    signer: authorPk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);

  const result = await module.verifyBlock(claimBlock.hash);
  assertEquals(result, { accepted: true });
});

Deno.test('Insurance: non-canonical reclaim rejects wrong return value', async () => {
  const { provider, module } = setup();

  const authorPk = pubkey('author');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [insOutput(1000, authorPk)],
    claims: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  // Author tries to reclaim more than deposited
  const claimBlock: TestBlock = {
    hash: h('reclaim'),
    anchor: anchor.hash,
    outputs: [sigOutput(authorPk, 9999)],
    claims: [1],
    refs: [],
    signer: authorPk,
    timestamp: 2000,
  };
  provider.addBlock(claimBlock);

  const result = await module.verifyBlock(claimBlock.hash);
  assertEquals(result.accepted, false);
});

// -- Tests: re-aggregation -------------------------------------------

Deno.test('Insurance: re-aggregation -- new aggregator claims old insurance', async () => {
  const { provider, module } = setup();

  const aggregator1Pk = pubkey('aggregator1');
  const aggregator2Pk = pubkey('aggregator2');

  // First aggregator's insurance
  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [insOutput(2500, aggregator1Pk)],
    claims: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  // Re-aggregator claims, returns 95% to original aggregator
  const minReturn = Math.floor(2500 * MIN_RETURN_RATE);
  const claimBlock: TestBlock = {
    hash: h('re-agg'),
    anchor: anchor.hash,
    outputs: [sigOutput(aggregator1Pk, minReturn)],
    claims: [1],
    refs: [],
    signer: aggregator2Pk,
    timestamp: 60_000,
  };
  provider.addBlock(claimBlock);

  const result = await module.verifyBlock(claimBlock.hash);
  assertEquals(result, { accepted: true });
});

// -- Tests: encode/decode round-trip ---------------------------------

Deno.test('Insurance: detail round-trips through encode/decode', () => {
  const pk = pubkey('test');
  const detail: InsuranceDetail = { pubkey: pk };
  const encoded = encodeInsuranceDetail(detail);
  const result = decodeInsuranceDetail(encoded);
  assertEquals(result.pubkey, pk);
});
