import { assert, assertEquals, assertThrows } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { Output, Verifier } from '../src/core/BlockCreationModule.ts';
import { RECORD_CONTRACT } from '../src/core/Block.ts';
import { makeRecordOutput } from '../src/contracts/RecordContract.ts';
import { ExecutionMode } from '../src/core/ContractEnv.ts';
import { ContractRejection, type VerifyingEnvProvider } from '../src/core/ContractEnv.ts';
import { VerifyingEnv } from '../src/core/VerifyingEnv.ts';

// -- Test block type -----------------------------------------------

interface TestBlock {
  hash: Hash;
  anchor: Hash;
  outputs: Output[];
  claimIndices: number[];
  refs: Hash[];
}

// -- Helpers -------------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

class TestProvider implements VerifyingEnvProvider<TestBlock> {
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

  getClaims(block: TestBlock): number[] {
    return block.claimIndices;
  }

  getRefs(block: TestBlock): Hash[] {
    return block.refs;
  }

  resolveClaim(block: TestBlock, claimIndex: number): Output | undefined {
    if (claimIndex < block.outputs.length) return block.outputs[claimIndex];
    if (Hash.equals(block.anchor, ZERO_HASH)) return undefined;
    const anchor = this.getBlock(block.anchor);
    if (!anchor) return undefined;
    return anchor.outputs[claimIndex - block.outputs.length];
  }
}

function makeEnv(opts: {
  contractHash?: Hash;
  params?: Uint8Array;
  block: TestBlock;
  provider: TestProvider;
  signer?: Uint8Array;
}): VerifyingEnv<TestBlock> {
  const provider = opts.provider;
  return new VerifyingEnv({
    contractHash: opts.contractHash ?? h('test-contract'),
    params: opts.params ?? new Uint8Array(0),
    block: opts.block,
    outputs: provider.getOutputs(opts.block),
    claimIndices: provider.getClaims(opts.block),
    refs: provider.getRefs(opts.block),
    provider,
    signer: opts.signer,
  });
}

// -- Tests: identity -----------------------------------------------

Deno.test('VerifyingEnv: mode is Verification', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  assertEquals(env.mode, ExecutionMode.Verification);
});

Deno.test('VerifyingEnv: contractHash and params', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const contractHash = h('my-contract');
  const params = enc('my-params');
  const env = makeEnv({ contractHash, params, block, provider });
  assert(Hash.equals(env.contractHash(), contractHash));
  assertEquals(env.params(), params);
});

// -- Tests: record ------------------------------------------

Deno.test('VerifyingEnv: record accepts when result matches', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [makeRecordOutput('state', enc('value'))],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  // Should not throw
  env.record(enc('state'), enc('value'));
});

Deno.test('VerifyingEnv: record throws on wrong value', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [makeRecordOutput('state', enc('actual'))],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  assertThrows(
    () => env.record(enc('state'), enc('expected')),
    ContractRejection,
    'body mismatch',
  );
});

Deno.test('VerifyingEnv: record throws when key not found', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  assertThrows(
    () => env.record(enc('missing'), enc('val')),
    ContractRejection,
    'namespace slot exhausted',
  );
});

// -- Tests: send ------------------------------------------

Deno.test('VerifyingEnv: send accepts when output exists', () => {
  const provider = new TestProvider();
  const verifier: Verifier = { contract: h('pay'), params: enc('key') };
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [{ verifier, value: 42, body: enc('data') }],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  env.send(verifier, 42, enc('data'));
});

Deno.test('VerifyingEnv: send accepts with default empty data', () => {
  const provider = new TestProvider();
  const verifier: Verifier = { contract: h('pay'), params: enc('key') };
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [{ verifier, value: 10, body: new Uint8Array(0) }],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  env.send(verifier, 10);
});

Deno.test('VerifyingEnv: send throws when output missing', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  assertThrows(
    () => env.send({ contract: h('x'), params: new Uint8Array(0) }, 1),
    ContractRejection,
    'namespace slot exhausted',
  );
});

// -- Tests: positional namespace matching --------------------------

Deno.test('VerifyingEnv: send matches positionally within namespace', () => {
  const provider = new TestProvider();
  const contract = h('pay');
  const vA: Verifier = { contract, params: enc('a') };
  const vB: Verifier = { contract, params: enc('b') };
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [
      { verifier: vA, value: 5, body: new Uint8Array(0) },
      { verifier: vB, value: 7, body: new Uint8Array(0) },
    ],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  env.send(vA, 5);
  env.send(vB, 7);
});

Deno.test('VerifyingEnv: send positional mismatch rejects', () => {
  const provider = new TestProvider();
  const contract = h('pay');
  const vA: Verifier = { contract, params: enc('a') };
  const vB: Verifier = { contract, params: enc('b') };
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [
      { verifier: vA, value: 5, body: new Uint8Array(0) },
      { verifier: vB, value: 7, body: new Uint8Array(0) },
    ],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  // Contract asked for B first, but block has A at slot 0.
  assertThrows(
    () => env.send(vB, 7),
    ContractRejection,
    'verifier mismatch',
  );
});

Deno.test('VerifyingEnv: request returns value/data from next namespace slot', () => {
  const provider = new TestProvider();
  const contract = h('pay');
  const v: Verifier = { contract, params: enc('a') };
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [{ verifier: v, value: 42, body: enc('payload') }],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  const result = env.request(v);
  assertEquals(result.value, 42);
  assertEquals(result.body, enc('payload'));
});

Deno.test('VerifyingEnv: request rejects when block slot uses a different verifier', () => {
  const provider = new TestProvider();
  const contract = h('pay');
  const vA: Verifier = { contract, params: enc('a') };
  const vB: Verifier = { contract, params: enc('b') };
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [{ verifier: vA, value: 5, body: new Uint8Array(0) }],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  assertThrows(
    () => env.request(vB),
    ContractRejection,
    'request verifier mismatch',
  );
});

Deno.test('VerifyingEnv: getEmittedSlots records origin per call', () => {
  const provider = new TestProvider();
  const contract = h('pay');
  const vA: Verifier = { contract, params: enc('a') };
  const vB: Verifier = { contract, params: enc('b') };
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [
      { verifier: vA, value: 5, body: new Uint8Array(0) },
      { verifier: vB, value: 7, body: enc('payload') },
    ],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  env.send(vA, 5);
  env.request(vB);
  const slots = env.getEmittedSlots();
  assertEquals(slots.length, 2);
  assertEquals(slots[0].origin, 'require');
  assertEquals(slots[1].origin, 'get');
});

// -- Tests: claimAll ------------------------------------------

Deno.test('VerifyingEnv: claimAll returns matching claimed outputs', () => {
  const provider = new TestProvider();
  const contractHash = h('game');
  const params = enc('config');
  const verifier: Verifier = { contract: contractHash, params };

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [
      { verifier, value: 10, body: enc('move1') },
      {
        verifier: { contract: h('other'), params: new Uint8Array(0) },
        value: 5,
        body: new Uint8Array(0),
      },
      { verifier, value: 20, body: enc('move2') },
    ],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(anchor);

  const block: TestBlock = {
    hash: h('b'),
    anchor: anchor.hash,
    outputs: [],
    claimIndices: [0, 1, 2], // claims all three anchor outputs
    refs: [],
  };
  provider.addBlock(block);

  const env = makeEnv({ contractHash, params, block, provider });
  const inputs = env.claimAll();
  assertEquals(inputs.length, 2);
  assertEquals(inputs[0].body, enc('move1'));
  assertEquals(inputs[1].body, enc('move2'));
});

Deno.test('VerifyingEnv: claimAll returns empty when no matching claims', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  assertEquals(env.claimAll(), []);
});

// -- Tests: claimNext -------------------------------------------

Deno.test('VerifyingEnv: claimNext returns inputs sequentially', () => {
  const provider = new TestProvider();
  const contractHash = h('game');
  const params = enc('cfg');
  const verifier: Verifier = { contract: contractHash, params };

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [
      { verifier, value: 1, body: enc('a') },
      { verifier, value: 2, body: enc('b') },
    ],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(anchor);

  const block: TestBlock = {
    hash: h('b'),
    anchor: anchor.hash,
    outputs: [],
    claimIndices: [0, 1],
    refs: [],
  };
  provider.addBlock(block);

  const env = makeEnv({ contractHash, params, block, provider });
  const first = env.claimNext();
  const second = env.claimNext();
  assertEquals(first.body, enc('a'));
  assertEquals(second.body, enc('b'));
});

Deno.test('VerifyingEnv: claimNext throws when no more inputs', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  assertThrows(() => env.claimNext(), ContractRejection, 'no more inputs');
});

// -- Tests: data-less outputs are invisible to contracts -----------

Deno.test('VerifyingEnv: claimAll skips data-less outputs', () => {
  const provider = new TestProvider();
  const contractHash = h('game');
  const params = enc('cfg');
  const verifier: Verifier = { contract: contractHash, params };

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [
      { verifier, value: 10, body: enc('move1') },
      { verifier, value: 99 }, // pure-incentive output -- invisible
      { verifier, value: 20, body: enc('move2') },
    ],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(anchor);

  const block: TestBlock = {
    hash: h('b'),
    anchor: anchor.hash,
    outputs: [],
    claimIndices: [0, 1, 2],
    refs: [],
  };
  provider.addBlock(block);

  const env = makeEnv({ contractHash, params, block, provider });
  const inputs = env.claimAll();
  assertEquals(inputs.length, 2);
  assertEquals(inputs[0].body, enc('move1'));
  assertEquals(inputs[1].body, enc('move2'));
});

Deno.test('VerifyingEnv: claimNext exhausts on filtered list', () => {
  const provider = new TestProvider();
  const contractHash = h('game');
  const params = enc('cfg');
  const verifier: Verifier = { contract: contractHash, params };

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [
      { verifier, value: 1, body: enc('a') },
      { verifier, value: 9 },
      { verifier, value: 2, body: enc('b') },
    ],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(anchor);

  const block: TestBlock = {
    hash: h('b'),
    anchor: anchor.hash,
    outputs: [],
    claimIndices: [0, 1, 2],
    refs: [],
  };
  provider.addBlock(block);

  const env = makeEnv({ contractHash, params, block, provider });
  const first = env.claimNext();
  const second = env.claimNext();
  assertEquals(first.body, enc('a'));
  assertEquals(second.body, enc('b'));
  // Third claimNext() must exhaust -- the data-less output is not counted.
  assertThrows(() => env.claimNext(), ContractRejection, 'no more inputs');
});

Deno.test('VerifyingEnv: fetch skips data-less record outputs', () => {
  const provider = new TestProvider();
  const gameVerifier: Verifier = { contract: h('game'), params: enc('cfg') };

  const prevAnchor: TestBlock = {
    hash: h('prev-anchor'),
    anchor: ZERO_HASH,
    outputs: [{ verifier: gameVerifier, value: 10, body: new Uint8Array(0) }],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(prevAnchor);

  const prevBlock: TestBlock = {
    hash: h('prev'),
    anchor: prevAnchor.hash,
    outputs: [
      // A data-less output that shares the RECORD_CONTRACT contract +
      // same params as the requested key must NOT be returned by fetch.
      { verifier: { contract: RECORD_CONTRACT, params: enc('state') }, value: 0 },
      makeRecordOutput('state', enc('S0')),
    ],
    claimIndices: [2], // claims extended index 2 = anchor's game output (anchor is at indices 2..)
    refs: [],
  };
  provider.addBlock(prevBlock);

  const block: TestBlock = {
    hash: h('current'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [prevBlock.hash],
  };
  provider.addBlock(block);

  const env = makeEnv({ block, provider });
  const result = env.fetch(gameVerifier, enc('state'));
  assertEquals(result, enc('S0'));
});

// -- Tests: fetch --------------------------------------------------

Deno.test('VerifyingEnv: fetch reads result from ref block that claims verifier', () => {
  const provider = new TestProvider();
  const gameVerifier: Verifier = { contract: h('game'), params: enc('cfg') };

  // A previous block that claims a game output and stores a result
  const prevAnchor: TestBlock = {
    hash: h('prev-anchor'),
    anchor: ZERO_HASH,
    outputs: [{ verifier: gameVerifier, value: 10, body: new Uint8Array(0) }],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(prevAnchor);

  const prevBlock: TestBlock = {
    hash: h('prev'),
    anchor: prevAnchor.hash,
    outputs: [
      makeRecordOutput('state', enc('S0')),
    ],
    claimIndices: [1], // claims extended index 1 = anchor's game output
    refs: [],
  };
  provider.addBlock(prevBlock);

  // Current block references prevBlock
  const block: TestBlock = {
    hash: h('current'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [prevBlock.hash],
  };
  provider.addBlock(block);

  const env = makeEnv({ block, provider });
  const result = env.fetch(gameVerifier, enc('state'));
  assertEquals(result, enc('S0'));
});

Deno.test('VerifyingEnv: fetch throws when no ref claims the verifier', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  assertThrows(
    () => env.fetch({ contract: h('x'), params: new Uint8Array(0) }, enc('key')),
    ContractRejection,
    'no ref block found',
  );
});

Deno.test('VerifyingEnv: fetch throws when ref claims verifier but no result key', () => {
  const provider = new TestProvider();
  const verifier: Verifier = { contract: h('game'), params: enc('cfg') };

  const prevAnchor: TestBlock = {
    hash: h('prev-anchor'),
    anchor: ZERO_HASH,
    outputs: [{ verifier, value: 5, body: new Uint8Array(0) }],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(prevAnchor);

  // Ref block claims the verifier but has no result outputs
  const refBlock: TestBlock = {
    hash: h('ref'),
    anchor: prevAnchor.hash,
    outputs: [],
    claimIndices: [0],
    refs: [],
  };
  provider.addBlock(refBlock);

  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [refBlock.hash],
  };
  provider.addBlock(block);

  const env = makeEnv({ block, provider });
  assertThrows(
    () => env.fetch(verifier, enc('missing-key')),
    ContractRejection,
    'no result for key',
  );
});

// -- Tests: sign ---------------------------------------

Deno.test('VerifyingEnv: sign passes when signer matches pubkey', () => {
  const provider = new TestProvider();
  const pubkey = enc('my-pubkey');
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ params: pubkey, block, provider, signer: pubkey });
  env.sign(pubkey);
});

Deno.test('VerifyingEnv: sign throws when signer does not match', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ params: enc('actual'), block, provider, signer: enc('actual') });
  assertThrows(
    () => env.sign(enc('expected')),
    ContractRejection,
    'block signer does not match',
  );
});

Deno.test('VerifyingEnv: sign throws when block is unsigned', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  assertThrows(
    () => env.sign(enc('any-key')),
    ContractRejection,
    'block is not signed',
  );
});

// -- Tests: contract execution pattern -----------------------------

Deno.test('VerifyingEnv: contract returning normally means accept', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [makeRecordOutput('k', enc('v'))],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });

  // Simulate a contract that does work and returns
  const contract = (e: VerifyingEnv<TestBlock>) => {
    e.record(enc('k'), enc('v'));
    // normal return = accept
  };
  contract(env); // should not throw
});

Deno.test('VerifyingEnv: contract throwing ContractRejection means reject', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });

  const contract = (_e: VerifyingEnv<TestBlock>) => {
    throw new ContractRejection('bad block');
  };
  assertThrows(() => contract(env), ContractRejection, 'bad block');
});

// -- Tests: contractMetadata ------------------------------------

Deno.test('VerifyingEnv: contractMetadata reads matching record from contract block', () => {
  const provider = new TestProvider();
  const contractHash = h('compiler');

  // The contract's own block carries metadata records.
  const contractBlock: TestBlock = {
    hash: contractHash,
    anchor: ZERO_HASH,
    outputs: [
      makeRecordOutput('abi_version', enc('20250510')),
      makeRecordOutput('output_namespaces', new Uint8Array(32)),
    ],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(contractBlock);

  // The executing block is unrelated.
  const block: TestBlock = {
    hash: h('exec'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);

  const env = makeEnv({ contractHash, block, provider });
  const result = env.contractMetadata({
    contract: RECORD_CONTRACT,
    params: enc('abi_version'),
  });
  assertEquals(result.body, enc('20250510'));
  assertEquals(result.value, 0);
});

Deno.test('VerifyingEnv: contractMetadata throws when contract block not loaded', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('exec'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);

  // contractHash points at a block we never added.
  const env = makeEnv({ contractHash: h('missing-contract'), block, provider });
  assertThrows(
    () =>
      env.contractMetadata({
        contract: RECORD_CONTRACT,
        params: enc('abi_version'),
      }),
    ContractRejection,
    'contract block not loaded',
  );
});

Deno.test('VerifyingEnv: contractMetadata throws when no matching output exists', () => {
  const provider = new TestProvider();
  const contractHash = h('compiler');
  const contractBlock: TestBlock = {
    hash: contractHash,
    anchor: ZERO_HASH,
    outputs: [makeRecordOutput('abi_version', enc('20250510'))],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(contractBlock);

  const block: TestBlock = {
    hash: h('exec'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);

  const env = makeEnv({ contractHash, block, provider });
  assertThrows(
    () =>
      env.contractMetadata({
        contract: RECORD_CONTRACT,
        params: enc('nonexistent'),
      }),
    ContractRejection,
    'no matching output on contract block',
  );
});

Deno.test('VerifyingEnv: put replays the sub-block hash from refs (in call order)', () => {
  const provider = new TestProvider();
  // Generation appended the created sub-block's hash to refs; verification
  // replays put()'s return value positionally. See docs/protocol/wasm-abi.md#put.
  const subHashA = h('sub-block-a');
  const subHashB = h('sub-block-b');
  const block: TestBlock = {
    hash: h('exec'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [subHashA, subHashB],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });

  const r1 = env.put({ contract: h('hash-contract'), params: enc('blob-1') }, {});
  assertEquals(r1.toHex(), subHashA.toHex());
  const r2 = env.put({ contract: h('hash-contract'), params: enc('blob-2') }, {});
  assertEquals(r2.toHex(), subHashB.toHex());
});

Deno.test('VerifyingEnv: put throws when the block carries no matching ref', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('exec'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  assertThrows(
    () => env.put({ contract: h('hash-contract'), params: enc('blob') }, {}),
    ContractRejection,
    'consumed more refs',
  );
});

Deno.test('VerifyingEnv: contractMetadata skips body-less outputs', () => {
  const provider = new TestProvider();
  const contractHash = h('compiler');
  const verifier: Verifier = {
    contract: RECORD_CONTRACT,
    params: enc('abi_version'),
  };
  const contractBlock: TestBlock = {
    hash: contractHash,
    anchor: ZERO_HASH,
    outputs: [
      // A body-less output (pure incentive) under the same verifier
      // must not satisfy contractMetadata.
      { verifier, value: 0 },
    ],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(contractBlock);

  const block: TestBlock = {
    hash: h('exec'),
    anchor: ZERO_HASH,
    outputs: [],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);

  const env = makeEnv({ contractHash, block, provider });
  assertThrows(
    () => env.contractMetadata(verifier),
    ContractRejection,
    'no matching output on contract block',
  );
});
