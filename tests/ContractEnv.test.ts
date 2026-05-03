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

function makeOutput(
  contractName: string,
  params: Uint8Array,
  value: number,
  data: Uint8Array,
): Output {
  return {
    verifier: { contract: h(contractName), params },
    value,
    data,
  };
}

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
  const block: TestBlock = { hash: h('b'), anchor: ZERO_HASH, outputs: [], claimIndices: [], refs: [] };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  assertEquals(env.mode, ExecutionMode.Verification);
});

Deno.test('VerifyingEnv: getContractHash and getParams', () => {
  const provider = new TestProvider();
  const block: TestBlock = { hash: h('b'), anchor: ZERO_HASH, outputs: [], claimIndices: [], refs: [] };
  provider.addBlock(block);
  const contractHash = h('my-contract');
  const params = enc('my-params');
  const env = makeEnv({ contractHash, params, block, provider });
  assert(Hash.equals(env.getContractHash(), contractHash));
  assertEquals(env.getParams(), params);
});

// -- Tests: requireResult ------------------------------------------

Deno.test('VerifyingEnv: requireResult accepts when result matches', () => {
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
  env.requireResult(enc('state'), enc('value'));
});

Deno.test('VerifyingEnv: requireResult throws on wrong value', () => {
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
    () => env.requireResult(enc('state'), enc('expected')),
    ContractRejection,
    'data mismatch',
  );
});

Deno.test('VerifyingEnv: requireResult throws when key not found', () => {
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
    () => env.requireResult(enc('missing'), enc('val')),
    ContractRejection,
    'namespace slot exhausted',
  );
});

// -- Tests: requireOutput ------------------------------------------

Deno.test('VerifyingEnv: requireOutput accepts when output exists', () => {
  const provider = new TestProvider();
  const verifier: Verifier = { contract: h('pay'), params: enc('key') };
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [{ verifier, value: 42, data: enc('data') }],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  env.requireOutput(verifier, 42, enc('data'));
});

Deno.test('VerifyingEnv: requireOutput accepts with default empty data', () => {
  const provider = new TestProvider();
  const verifier: Verifier = { contract: h('pay'), params: enc('key') };
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [{ verifier, value: 10, data: new Uint8Array(0) }],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  env.requireOutput(verifier, 10);
});

Deno.test('VerifyingEnv: requireOutput throws when output missing', () => {
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
    () => env.requireOutput({ contract: h('x'), params: new Uint8Array(0) }, 1),
    ContractRejection,
    'namespace slot exhausted',
  );
});

// -- Tests: positional namespace matching --------------------------

Deno.test('VerifyingEnv: requireOutput matches positionally within namespace', () => {
  const provider = new TestProvider();
  const contract = h('pay');
  const vA: Verifier = { contract, params: enc('a') };
  const vB: Verifier = { contract, params: enc('b') };
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [
      { verifier: vA, value: 5, data: new Uint8Array(0) },
      { verifier: vB, value: 7, data: new Uint8Array(0) },
    ],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  env.requireOutput(vA, 5);
  env.requireOutput(vB, 7);
});

Deno.test('VerifyingEnv: requireOutput positional mismatch rejects', () => {
  const provider = new TestProvider();
  const contract = h('pay');
  const vA: Verifier = { contract, params: enc('a') };
  const vB: Verifier = { contract, params: enc('b') };
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [
      { verifier: vA, value: 5, data: new Uint8Array(0) },
      { verifier: vB, value: 7, data: new Uint8Array(0) },
    ],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  // Contract asked for B first, but block has A at slot 0.
  assertThrows(
    () => env.requireOutput(vB, 7),
    ContractRejection,
    'verifier mismatch',
  );
});

Deno.test('VerifyingEnv: getOutput returns value/data from next namespace slot', () => {
  const provider = new TestProvider();
  const contract = h('pay');
  const v: Verifier = { contract, params: enc('a') };
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [{ verifier: v, value: 42, data: enc('payload') }],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  const result = env.getOutput(v);
  assertEquals(result.value, 42);
  assertEquals(result.data, enc('payload'));
});

Deno.test('VerifyingEnv: getOutput rejects when block slot uses a different verifier', () => {
  const provider = new TestProvider();
  const contract = h('pay');
  const vA: Verifier = { contract, params: enc('a') };
  const vB: Verifier = { contract, params: enc('b') };
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [{ verifier: vA, value: 5, data: new Uint8Array(0) }],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  assertThrows(
    () => env.getOutput(vB),
    ContractRejection,
    'getOutput verifier mismatch',
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
      { verifier: vA, value: 5, data: new Uint8Array(0) },
      { verifier: vB, value: 7, data: enc('payload') },
    ],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  env.requireOutput(vA, 5);
  env.getOutput(vB);
  const slots = env.getEmittedSlots();
  assertEquals(slots.length, 2);
  assertEquals(slots[0].origin, 'require');
  assertEquals(slots[1].origin, 'get');
});

// -- Tests: collectInputs ------------------------------------------

Deno.test('VerifyingEnv: collectInputs returns matching claimed outputs', () => {
  const provider = new TestProvider();
  const contractHash = h('game');
  const params = enc('config');
  const verifier: Verifier = { contract: contractHash, params };

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [
      { verifier, value: 10, data: enc('move1') },
      {
        verifier: { contract: h('other'), params: new Uint8Array(0) },
        value: 5,
        data: new Uint8Array(0),
      },
      { verifier, value: 20, data: enc('move2') },
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
  const inputs = env.collectInputs();
  assertEquals(inputs.length, 2);
  assertEquals(inputs[0].data, enc('move1'));
  assertEquals(inputs[1].data, enc('move2'));
});

Deno.test('VerifyingEnv: collectInputs returns empty when no matching claims', () => {
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
  assertEquals(env.collectInputs(), []);
});

// -- Tests: requireInput -------------------------------------------

Deno.test('VerifyingEnv: requireInput returns inputs sequentially', () => {
  const provider = new TestProvider();
  const contractHash = h('game');
  const params = enc('cfg');
  const verifier: Verifier = { contract: contractHash, params };

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [
      { verifier, value: 1, data: enc('a') },
      { verifier, value: 2, data: enc('b') },
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
  const first = env.requireInput();
  const second = env.requireInput();
  assertEquals(first.data, enc('a'));
  assertEquals(second.data, enc('b'));
});

Deno.test('VerifyingEnv: requireInput throws when no more inputs', () => {
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
  assertThrows(() => env.requireInput(), ContractRejection, 'no more inputs');
});

// -- Tests: null-data outputs are invisible to contracts -----------

Deno.test('VerifyingEnv: collectInputs skips null-data outputs', () => {
  const provider = new TestProvider();
  const contractHash = h('game');
  const params = enc('cfg');
  const verifier: Verifier = { contract: contractHash, params };

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [
      { verifier, value: 10, data: enc('move1') },
      { verifier, value: 99, data: null }, // pure-incentive output -- invisible
      { verifier, value: 20, data: enc('move2') },
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
  const inputs = env.collectInputs();
  assertEquals(inputs.length, 2);
  assertEquals(inputs[0].data, enc('move1'));
  assertEquals(inputs[1].data, enc('move2'));
});

Deno.test('VerifyingEnv: requireInput exhausts on filtered list', () => {
  const provider = new TestProvider();
  const contractHash = h('game');
  const params = enc('cfg');
  const verifier: Verifier = { contract: contractHash, params };

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [
      { verifier, value: 1, data: enc('a') },
      { verifier, value: 9, data: null },
      { verifier, value: 2, data: enc('b') },
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
  const first = env.requireInput();
  const second = env.requireInput();
  assertEquals(first.data, enc('a'));
  assertEquals(second.data, enc('b'));
  // Third requireInput() must exhaust -- the null-data output is not counted.
  assertThrows(() => env.requireInput(), ContractRejection, 'no more inputs');
});

Deno.test('VerifyingEnv: fetch skips null-data record outputs', () => {
  const provider = new TestProvider();
  const gameVerifier: Verifier = { contract: h('game'), params: enc('cfg') };

  const prevAnchor: TestBlock = {
    hash: h('prev-anchor'),
    anchor: ZERO_HASH,
    outputs: [{ verifier: gameVerifier, value: 10, data: new Uint8Array(0) }],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(prevAnchor);

  const prevBlock: TestBlock = {
    hash: h('prev'),
    anchor: prevAnchor.hash,
    outputs: [
      // A null-data output that shares the RECORD_CONTRACT contract +
      // same params as the requested key must NOT be returned by fetch.
      { verifier: { contract: RECORD_CONTRACT, params: enc('state') }, value: 0, data: null },
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
    outputs: [{ verifier: gameVerifier, value: 10, data: new Uint8Array(0) }],
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
    outputs: [{ verifier, value: 5, data: new Uint8Array(0) }],
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

// -- Tests: requireSignature ---------------------------------------

Deno.test('VerifyingEnv: requireSignature passes when signer matches pubkey', () => {
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
  env.requireSignature(pubkey);
});

Deno.test('VerifyingEnv: requireSignature throws when signer does not match', () => {
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
    () => env.requireSignature(enc('expected')),
    ContractRejection,
    'block signer does not match',
  );
});

Deno.test('VerifyingEnv: requireSignature throws when block is unsigned', () => {
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
    () => env.requireSignature(enc('any-key')),
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
    e.requireResult(enc('k'), enc('v'));
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
