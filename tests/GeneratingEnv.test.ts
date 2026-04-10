import { assert, assertEquals, assertRejects } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { Output, Verifier } from '../src/core/BlockCreationModule.ts';
import { RECORD_CONTRACT } from '../src/core/Block.ts';
import { makeRecordOutput } from '../src/contracts/RecordContract.ts';
import { ExecutionMode } from '../src/core/ExecutionModule.ts';
import {
  type AvailableInput,
  type ContractEnv,
  ContractRejection,
  type GeneratingEnvProvider,
  type Input,
} from '../src/core/ContractEnv.ts';
import { GeneratingEnv } from '../src/core/GeneratingEnv.ts';
import { VerifyingEnv } from '../src/core/VerifyingEnv.ts';
import type { MaybePromise } from '../src/util/MaybePromise.ts';

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

class TestGenProvider implements GeneratingEnvProvider<TestBlock> {
  readonly blocks = new Map<string, TestBlock>();
  private readonly _availableInputs = new Map<string, AvailableInput[]>();
  private readonly _blocksClaiming = new Map<string, Hash>();

  addBlock(block: TestBlock): void {
    this.blocks.set(block.hash.toHex(), block);
  }

  setAvailableInputs(verifier: Verifier, inputs: AvailableInput[]): void {
    this._availableInputs.set(
      verifier.contract.toHex() + ':' + Array.from(verifier.params).join(','),
      inputs,
    );
  }

  setBlockClaiming(verifier: Verifier, blockHash: Hash): void {
    this._blocksClaiming.set(
      verifier.contract.toHex() + ':' + Array.from(verifier.params).join(','),
      blockHash,
    );
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

  findInputs(verifier: Verifier): MaybePromise<AvailableInput[]> {
    const key = verifier.contract.toHex() + ':' + Array.from(verifier.params).join(',');
    return this._availableInputs.get(key) ?? [];
  }

  findBlockClaiming(verifier: Verifier): MaybePromise<Hash | undefined> {
    const key = verifier.contract.toHex() + ':' + Array.from(verifier.params).join(',');
    return this._blocksClaiming.get(key);
  }
}

function makeGenEnv(opts?: {
  contractHash?: Hash;
  params?: Uint8Array;
  provider?: TestGenProvider;
}): { env: GeneratingEnv<TestBlock>; provider: TestGenProvider } {
  const provider = opts?.provider ?? new TestGenProvider();
  const env = new GeneratingEnv({
    contractHash: opts?.contractHash ?? h('test-contract'),
    params: opts?.params ?? new Uint8Array(0),
    provider,
  });
  return { env, provider };
}

// -- Tests: identity -----------------------------------------------

Deno.test('GeneratingEnv: mode is Generation', () => {
  const { env } = makeGenEnv();
  assertEquals(env.mode, ExecutionMode.Generation);
});

Deno.test('GeneratingEnv: getContractHash and getParams', () => {
  const contractHash = h('my-contract');
  const params = enc('my-params');
  const { env } = makeGenEnv({ contractHash, params });
  assert(Hash.equals(env.getContractHash(), contractHash));
  assertEquals(env.getParams(), params);
});

// -- Tests: requireResult ------------------------------------------

Deno.test('GeneratingEnv: requireResult creates a result output', () => {
  const { env } = makeGenEnv();
  env.requireResult(enc('state'), enc('value'));

  const results = env.getGeneratedResults();
  assertEquals(results.length, 1);
  assert(Hash.equals(results[0].verifier.contract, RECORD_CONTRACT));
  assertEquals(results[0].verifier.params, enc('state'));
  assertEquals(results[0].data, enc('value'));
  assertEquals(results[0].value, 0);
});

Deno.test('GeneratingEnv: multiple requireResult calls', () => {
  const { env } = makeGenEnv();
  env.requireResult(enc('a'), enc('1'));
  env.requireResult(enc('b'), enc('2'));

  const results = env.getGeneratedResults();
  assertEquals(results.length, 2);
});

// -- Tests: requireOutput ------------------------------------------

Deno.test('GeneratingEnv: requireOutput adds output to list', () => {
  const { env } = makeGenEnv();
  const verifier: Verifier = { contract: h('pay'), params: enc('pk') };
  env.requireOutput(verifier, 42, enc('data'));

  const outputs = env.getGeneratedOutputs();
  assertEquals(outputs.length, 1);
  assert(Hash.equals(outputs[0].verifier.contract, verifier.contract));
  assertEquals(outputs[0].value, 42);
  assertEquals(outputs[0].data, enc('data'));
});

Deno.test('GeneratingEnv: requireOutput defaults data to empty', () => {
  const { env } = makeGenEnv();
  env.requireOutput({ contract: h('x'), params: new Uint8Array(0) }, 10);
  assertEquals(env.getGeneratedOutputs()[0].data, new Uint8Array(0));
});

// -- Tests: collectInputs ------------------------------------------

Deno.test('GeneratingEnv: collectInputs queries provider', () => {
  const provider = new TestGenProvider();
  const contractHash = h('game');
  const params = enc('cfg');
  const verifier: Verifier = { contract: contractHash, params };

  const available: AvailableInput[] = [
    { verifier, value: 10, data: enc('move1'), isSelfClaim: false, block: h('b1'), outputIndex: 0 },
    { verifier, value: 20, data: enc('move2'), isSelfClaim: false, block: h('b2'), outputIndex: 1 },
  ];
  provider.setAvailableInputs(verifier, available);

  const { env } = makeGenEnv({ contractHash, params, provider });
  const result = env.collectInputs() as Input[];
  assertEquals(result.length, 2);
  assertEquals(result[0].value, 10);
  assertEquals(result[1].value, 20);

  // Resolved claims track provenance
  const claims = env.getResolvedClaims();
  assertEquals(claims.length, 2);
  assert(Hash.equals(claims[0].block, h('b1')));
  assertEquals(claims[0].outputIndex, 0);
  assertEquals(claims[0].value, 10);
  assert(Hash.equals(claims[1].block, h('b2')));
  assertEquals(claims[1].outputIndex, 1);
  assertEquals(claims[1].value, 20);
});

Deno.test('GeneratingEnv: collectInputs returns empty when no inputs', () => {
  const { env } = makeGenEnv();
  assertEquals(env.collectInputs(), []);
});

// -- Tests: requireInput -------------------------------------------

Deno.test('GeneratingEnv: requireInput returns first available input', () => {
  const provider = new TestGenProvider();
  const contractHash = h('game');
  const params = enc('cfg');
  const verifier: Verifier = { contract: contractHash, params };

  const available: AvailableInput[] = [
    { verifier, value: 5, data: enc('data'), isSelfClaim: false, block: h('b1'), outputIndex: 2 },
  ];
  provider.setAvailableInputs(verifier, available);

  const { env } = makeGenEnv({ contractHash, params, provider });
  const input = env.requireInput() as Input;
  assertEquals(input.value, 5);
  assertEquals(input.data, enc('data'));

  // Resolved claim tracks provenance
  const claims = env.getResolvedClaims();
  assertEquals(claims.length, 1);
  assert(Hash.equals(claims[0].block, h('b1')));
  assertEquals(claims[0].outputIndex, 2);
});

Deno.test('GeneratingEnv: requireInput throws when no inputs', () => {
  const { env } = makeGenEnv();
  try {
    env.requireInput();
    assert(false, 'should have thrown');
  } catch (e) {
    assert(e instanceof ContractRejection);
  }
});

// -- Tests: fetch --------------------------------------------------

Deno.test('GeneratingEnv: fetch queries provider and records ref', () => {
  const provider = new TestGenProvider();
  const gameVerifier: Verifier = { contract: h('game'), params: enc('cfg') };

  const refBlock: TestBlock = {
    hash: h('ref-block'),
    anchor: ZERO_HASH,
    outputs: [makeRecordOutput('state', enc('S0'))],
    claims: [],
    refs: [],
  };
  provider.addBlock(refBlock);
  provider.setBlockClaiming(gameVerifier, refBlock.hash);

  const { env } = makeGenEnv({ provider });
  const result = env.fetch(gameVerifier, enc('state'));
  assertEquals(result, enc('S0'));

  const refs = env.getGeneratedRefs();
  assertEquals(refs.length, 1);
  assert(Hash.equals(refs[0], refBlock.hash));
});

Deno.test('GeneratingEnv: fetch throws when no block claims verifier', () => {
  const { env } = makeGenEnv();
  try {
    env.fetch({ contract: h('x'), params: new Uint8Array(0) }, enc('key'));
    assert(false, 'should have thrown');
  } catch (e) {
    assert(e instanceof ContractRejection);
  }
});

// -- Tests: getAllOutputs ------------------------------------------

Deno.test('GeneratingEnv: getAllOutputs returns results then regular outputs', () => {
  const { env } = makeGenEnv();
  env.requireResult(enc('state'), enc('val'));
  env.requireOutput({ contract: h('pay'), params: enc('pk') }, 50);

  const all = env.getAllOutputs();
  assertEquals(all.length, 2);
  assert(Hash.equals(all[0].verifier.contract, RECORD_CONTRACT));
  assert(Hash.equals(all[1].verifier.contract, h('pay')));
});

// -- Tests: round-trip (same contract works in both modes) ---------

Deno.test('GeneratingEnv: round-trip -- same contract works in generate and verify', () => {
  const gameVerifier: Verifier = { contract: h('game'), params: enc('cfg') };

  // A contract that reads previous state, computes new state, and requires outputs
  const contract = (env: ContractEnv) => {
    const prevState = env.fetch(gameVerifier, enc('state'));
    // In sync context, prevState is Uint8Array directly
    const state = prevState as Uint8Array;
    const newState = new Uint8Array([...state, 1]);

    env.requireResult(enc('state'), newState);
    env.requireOutput(
      { contract: h('sig'), params: enc('creator') },
      10,
      new Uint8Array(0),
    );
  };

  // --- Generation ---
  const genProvider = new TestGenProvider();
  const refBlock: TestBlock = {
    hash: h('prev'),
    anchor: ZERO_HASH,
    outputs: [makeRecordOutput('state', enc('S'))],
    claims: [],
    refs: [],
  };
  genProvider.addBlock(refBlock);
  genProvider.setBlockClaiming(gameVerifier, refBlock.hash);

  const genEnv = new GeneratingEnv<TestBlock>({
    contractHash: h('game'),
    params: enc('cfg'),
    provider: genProvider,
  });
  contract(genEnv);

  const generatedOutputs = genEnv.getAllOutputs();
  const generatedRefs = genEnv.getGeneratedRefs();

  // --- Verification ---
  // Build a block from the generated outputs
  const block: TestBlock = {
    hash: h('new-block'),
    anchor: ZERO_HASH,
    outputs: generatedOutputs,
    claims: [],
    refs: generatedRefs,
  };

  // Add the ref block to verification provider too
  const verProvider = new TestGenProvider();
  verProvider.addBlock(refBlock);
  verProvider.addBlock(block);

  // Make the ref block look like it claims the game verifier
  const anchorForRef: TestBlock = {
    hash: h('ref-anchor'),
    anchor: ZERO_HASH,
    outputs: [{ verifier: gameVerifier, value: 0, data: new Uint8Array(0) }],
    claims: [],
    refs: [],
  };
  verProvider.addBlock(anchorForRef);

  // Update refBlock to have claims for verification
  const refBlockWithClaims: TestBlock = {
    ...refBlock,
    anchor: anchorForRef.hash,
    claims: [1], // claims the game output from anchor
  };
  verProvider.blocks.set(refBlock.hash.toHex(), refBlockWithClaims);

  const verEnv = new VerifyingEnv<TestBlock>({
    contractHash: h('game'),
    params: enc('cfg'),
    block,
    outputs: block.outputs,
    claims: block.claims,
    extendedOutputs: verProvider.getExtendedOutputs(block),
    refs: block.refs,
    provider: verProvider,
  });

  // Should not throw -- verification passes with the same contract
  contract(verEnv);
});
