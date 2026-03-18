import { assert, assertEquals, assertThrows } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { Output, Verifier } from '../src/core/BlockCreationModule.ts';
import { createSelfClaimedOutput, RESULT_CONTRACT } from '../src/core/Block.ts';
import { ExecutionMode } from '../src/core/ExecutionModule.ts';
import { ContractRejection, type VerifyingEnvProvider } from '../src/core/ContractEnv.ts';
import { VerifyingEnv } from '../src/core/VerifyingEnv.ts';

// -- Test block type -----------------------------------------------

interface TestBlock {
  hash: Hash;
  anchor: Hash;
  outputs: Output[];
  claims: number[];
  refs: Hash[];
}

// -- Helpers -------------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function makeOutput(
  contractName: string,
  params: Uint8Array,
  value: number,
  detail: Uint8Array,
): Output {
  return {
    verifier: { contract: h(contractName), params },
    value,
    detail,
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
    return block.claims;
  }

  getRefs(block: TestBlock): Hash[] {
    return block.refs;
  }

  getExtendedOutputs(block: TestBlock): Output[] {
    const result: Output[] = [...block.outputs];
    if (Hash.equals(block.anchor, ZERO_HASH)) return result;
    const anchor = this.getBlock(block.anchor);
    if (anchor) result.push(...anchor.outputs);
    return result;
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
    claims: provider.getClaims(opts.block),
    extendedOutputs: provider.getExtendedOutputs(opts.block),
    refs: provider.getRefs(opts.block),
    provider,
    signer: opts.signer,
  });
}

// -- Tests: identity -----------------------------------------------

Deno.test('VerifyingEnv: mode is Verification', () => {
  const provider = new TestProvider();
  const block: TestBlock = { hash: h('b'), anchor: ZERO_HASH, outputs: [], claims: [], refs: [] };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  assertEquals(env.mode, ExecutionMode.Verification);
});

Deno.test('VerifyingEnv: getContractHash and getParams', () => {
  const provider = new TestProvider();
  const block: TestBlock = { hash: h('b'), anchor: ZERO_HASH, outputs: [], claims: [], refs: [] };
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
    outputs: [createSelfClaimedOutput('state', enc('value'))],
    claims: [],
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
    outputs: [createSelfClaimedOutput('state', enc('actual'))],
    claims: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  assertThrows(
    () => env.requireResult(enc('state'), enc('expected')),
    ContractRejection,
    'wrong value',
  );
});

Deno.test('VerifyingEnv: requireResult throws when key not found', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [],
    claims: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  assertThrows(() => env.requireResult(enc('missing'), enc('val')), ContractRejection, 'not found');
});

// -- Tests: requireOutput ------------------------------------------

Deno.test('VerifyingEnv: requireOutput accepts when output exists', () => {
  const provider = new TestProvider();
  const verifier: Verifier = { contract: h('pay'), params: enc('key') };
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [{ verifier, value: 42, detail: enc('data') }],
    claims: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  env.requireOutput(verifier, 42, enc('data'));
});

Deno.test('VerifyingEnv: requireOutput accepts with default empty detail', () => {
  const provider = new TestProvider();
  const verifier: Verifier = { contract: h('pay'), params: enc('key') };
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [{ verifier, value: 10, detail: new Uint8Array(0) }],
    claims: [],
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
    claims: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  assertThrows(
    () => env.requireOutput({ contract: h('x'), params: new Uint8Array(0) }, 1),
    ContractRejection,
    'required output not found',
  );
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
      { verifier, value: 10, detail: enc('move1') },
      {
        verifier: { contract: h('other'), params: new Uint8Array(0) },
        value: 5,
        detail: new Uint8Array(0),
      },
      { verifier, value: 20, detail: enc('move2') },
    ],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  const block: TestBlock = {
    hash: h('b'),
    anchor: anchor.hash,
    outputs: [],
    claims: [0, 1, 2], // claims all three anchor outputs
    refs: [],
  };
  provider.addBlock(block);

  const env = makeEnv({ contractHash, params, block, provider });
  const inputs = env.collectInputs();
  assertEquals(inputs.length, 2);
  assertEquals(inputs[0].detail, enc('move1'));
  assertEquals(inputs[1].detail, enc('move2'));
});

Deno.test('VerifyingEnv: collectInputs returns empty when no matching claims', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [],
    claims: [],
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
      { verifier, value: 1, detail: enc('a') },
      { verifier, value: 2, detail: enc('b') },
    ],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  const block: TestBlock = {
    hash: h('b'),
    anchor: anchor.hash,
    outputs: [],
    claims: [0, 1],
    refs: [],
  };
  provider.addBlock(block);

  const env = makeEnv({ contractHash, params, block, provider });
  const first = env.requireInput();
  const second = env.requireInput();
  assertEquals(first.detail, enc('a'));
  assertEquals(second.detail, enc('b'));
});

Deno.test('VerifyingEnv: requireInput throws when no more inputs', () => {
  const provider = new TestProvider();
  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [],
    claims: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });
  assertThrows(() => env.requireInput(), ContractRejection, 'no more inputs');
});

// -- Tests: fetch --------------------------------------------------

Deno.test('VerifyingEnv: fetch reads result from ref block that claims verifier', () => {
  const provider = new TestProvider();
  const gameVerifier: Verifier = { contract: h('game'), params: enc('cfg') };

  // A previous block that claims a game output and stores a result
  const prevAnchor: TestBlock = {
    hash: h('prev-anchor'),
    anchor: ZERO_HASH,
    outputs: [{ verifier: gameVerifier, value: 10, detail: new Uint8Array(0) }],
    claims: [],
    refs: [],
  };
  provider.addBlock(prevAnchor);

  const prevBlock: TestBlock = {
    hash: h('prev'),
    anchor: prevAnchor.hash,
    outputs: [
      createSelfClaimedOutput('state', enc('S0')),
    ],
    claims: [1], // claims extended index 1 = anchor's game output
    refs: [],
  };
  provider.addBlock(prevBlock);

  // Current block references prevBlock
  const block: TestBlock = {
    hash: h('current'),
    anchor: ZERO_HASH,
    outputs: [],
    claims: [],
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
    claims: [],
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
    outputs: [{ verifier, value: 5, detail: new Uint8Array(0) }],
    claims: [],
    refs: [],
  };
  provider.addBlock(prevAnchor);

  // Ref block claims the verifier but has no result outputs
  const refBlock: TestBlock = {
    hash: h('ref'),
    anchor: prevAnchor.hash,
    outputs: [],
    claims: [0],
    refs: [],
  };
  provider.addBlock(refBlock);

  const block: TestBlock = {
    hash: h('b'),
    anchor: ZERO_HASH,
    outputs: [],
    claims: [],
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
    claims: [],
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
    claims: [],
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
    claims: [],
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
    outputs: [createSelfClaimedOutput('k', enc('v'))],
    claims: [],
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
    claims: [],
    refs: [],
  };
  provider.addBlock(block);
  const env = makeEnv({ block, provider });

  const contract = (_e: VerifyingEnv<TestBlock>) => {
    throw new ContractRejection('bad block');
  };
  assertThrows(() => contract(env), ContractRejection, 'bad block');
});
